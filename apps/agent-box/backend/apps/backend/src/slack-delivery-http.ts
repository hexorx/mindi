const unknown = () => new Error("Slack request outcome is unknown");
export class SlackRateLimitError extends Error {
  constructor(readonly retryAfterMs?: number) {
    super("Slack requests are rate limited");
  }
}
export type SlackMethod =
  | "conversations.open"
  | "conversations.info"
  | "conversations.list"
  | "auth.test"
  | "chat.postMessage"
  | "conversations.history"
  | "conversations.replies"
  | "files.info"
  | "files.getUploadURLExternal"
  | "files.completeUploadExternal";
const methods: readonly SlackMethod[] = [
  "conversations.open",
  "conversations.info",
  "conversations.list",
  "auth.test",
  "chat.postMessage",
  "conversations.history",
  "conversations.replies",
  "files.info",
  "files.getUploadURLExternal",
  "files.completeUploadExternal",
];
export function slackUploadUrl(value: string): string {
  if (typeof value !== "string" || value.length > 8192) throw unknown();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unknown();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.slack.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/upload\/v1\/[A-Za-z0-9_/-]+$/.test(url.pathname) ||
    url.href !== value
  )
    throw unknown();
  return url.href;
}
/** Fixed endpoints and bounded responses; injected fetch is a fixture seam only. */
export function createSlackHttp(options: {
  token: string;
  request?: typeof fetch;
  guard?: () => void;
  rateLimit?: (retryAfterMs?: number) => void;
}) {
  const request = options.request ?? fetch;
  if (
    !options.token ||
    options.token.length > 16384 ||
    /[^\x21-\x7e]/.test(options.token)
  )
    throw Error("Invalid Slack credential");
  async function response(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    exactStatus?: number,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    options.guard?.();
    let result: Response;
    try {
      result = await request(url, { ...init, signal, redirect: "error" });
    } catch {
      throw unknown();
    }
    if (result.status === 429) {
      const value = result.headers.get("retry-after");
      const seconds =
        value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
      const ms =
        Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86400
          ? seconds * 1000
          : undefined;
      options.rateLimit?.(ms);
      await result.body?.cancel().catch(() => {});
      throw new SlackRateLimitError(ms);
    }
    if (
      !result.ok ||
      result.redirected ||
      (exactStatus !== undefined && result.status !== exactStatus)
    ) {
      await result.body?.cancel().catch(() => {});
      throw unknown();
    }
    const reader = result.body?.getReader();
    if (!reader) throw unknown();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 1024 * 1024) throw unknown();
        chunks.push(next.value);
      }
      signal.throwIfAborted();
      return Buffer.concat(chunks);
    } catch {
      await reader.cancel().catch(() => {});
      throw unknown();
    } finally {
      reader.releaseLock();
    }
  }
  return {
    async api(
      method: SlackMethod,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<Record<string, unknown>> {
      if (!methods.includes(method)) throw unknown();
      const write = ![
        "conversations.info",
        "conversations.list",
        "files.info",
        "conversations.history",
        "conversations.replies",
      ].includes(method);
      const url = new URL("https://slack.com/api/" + method);
      if (!write)
        for (const [key, value] of Object.entries(args))
          url.searchParams.set(key, String(value));
      const bytes = await response(
        url.href,
        {
          method: write ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json; charset=utf-8",
          },
          ...(write ? { body: JSON.stringify(args) } : {}),
        },
        signal,
      );
      try {
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw unknown();
        return value as Record<string, unknown>;
      } catch {
        throw unknown();
      }
    },
    async upload(
      url: string,
      bytes: Uint8Array,
      signal: AbortSignal,
    ): Promise<void> {
      const safeUrl = slackUploadUrl(url);
      if (!bytes.length) throw Error("Slack cannot upload an empty file");
      await response(
        safeUrl,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: Uint8Array.from(bytes).buffer,
        },
        signal,
        200,
      );
    },
  };
}
export type SlackHttp = ReturnType<typeof createSlackHttp>;
