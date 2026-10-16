import { ConnectorError } from "./types.js";
export class TelegramRequestError extends ConnectorError {
  constructor(
    readonly retryAfterMs?: number,
    readonly httpStatus?: number,
  ) {
    super("unavailable", "Telegram request failed");
  }
}
/** Fixed-origin, bounded Bot API reads. Provider error text and tokens never escape. */
export function telegramApi(token: string, request: typeof fetch = fetch) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || token.length > 16384)
    throw new ConnectorError("invalid", "Invalid Telegram credential");
  return async (
    method: "getMe" | "getWebhookInfo" | "getUpdates" | "getFile",
    body: Record<string, unknown>,
    parentSignal: AbortSignal,
  ): Promise<unknown> => {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30000)]);
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await request(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal,
        },
      );
    } catch {
      throw new TelegramRequestError();
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TelegramRequestError(undefined, response.status);
    let size = 0;
    const chunks: Uint8Array[] = [];
    let value: unknown;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024 * 1024) throw new TelegramRequestError();
        chunks.push(part.value);
      }
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      await reader.cancel().catch(() => {});
      throw new TelegramRequestError(
        undefined,
        response.status === 429 ? 429 : undefined,
      );
    } finally {
      reader.releaseLock();
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new TelegramRequestError(undefined, response.status);
    const result = value as Record<string, unknown>;
    if (!response.ok || result.ok !== true) {
      const parameters = result.parameters as
        Record<string, unknown> | undefined;
      const seconds = parameters?.retry_after;
      throw new TelegramRequestError(
        response.status === 429 &&
          typeof seconds === "number" &&
          Number.isSafeInteger(seconds) &&
          seconds >= 0 &&
          seconds <= 86400
          ? seconds * 1000
          : undefined,
        response.status,
      );
    }
    return result.result;
  };
}
