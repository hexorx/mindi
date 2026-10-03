import { ConnectorError } from "./types.js";
import { discordObject } from "./discord-events.js";
export class DiscordRetry extends ConnectorError {
  constructor(
    readonly retryAfterMs: number,
    message = "Discord request requires retry",
  ) {
    super("unavailable", message);
  }
}
/** Fixed-origin, bounded REST reader. Provider bodies/errors never become diagnostics. */
export async function discordGet(
  path: string,
  token: string,
  request: typeof fetch,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!/^\/(users\/@me|gateway\/bot|channels\/[1-9][0-9]{0,19})$/.test(path))
    throw new ConnectorError("invalid", "Invalid Discord resource");
  const timeout = AbortSignal.timeout(30000);
  try {
    const response = await request(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${token}` },
      redirect: "error",
      signal: AbortSignal.any([signal, timeout]),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ConnectorError(
        "unauthorized",
        "Discord authorization or required access unavailable",
      );
    }
    if (response.status !== 429 && !response.ok) {
      await response.body?.cancel();
      if (response.status >= 500) throw new DiscordRetry(5000);
      throw new ConnectorError("unavailable", "Discord request failed");
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new ConnectorError("unavailable", "Discord response missing");
    let total = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > 1024 * 1024)
          throw new ConnectorError(
            "unavailable",
            "Discord response size limit",
          );
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const data = discordObject(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (response.status === 429) {
      const seconds = data.retry_after;
      if (
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds < 0 ||
        seconds > 86400
      )
        throw new ConnectorError("unavailable", "Invalid Discord retry delay");
      throw new DiscordRetry(Math.max(1000, Math.ceil(seconds * 1000)));
    }
    return data;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (signal.aborted)
      throw new ConnectorError("unavailable", "Discord receiver stopped");
    throw new DiscordRetry(5000, "Discord transport unavailable");
  }
}
export function discordGatewayUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048)
    throw new ConnectorError("invalid", "Invalid Discord Gateway URL");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ConnectorError("invalid", "Invalid Discord Gateway URL");
  }
  if (
    url.protocol !== "wss:" ||
    !(
      url.hostname === "gateway.discord.gg" ||
      url.hostname.endsWith(".discord.gg")
    ) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new ConnectorError("invalid", "Invalid Discord Gateway URL");
  url.search = "?v=10&encoding=json";
  return url.toString();
}
