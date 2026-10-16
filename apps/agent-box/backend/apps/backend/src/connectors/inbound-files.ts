import { ConnectorError } from "./types.js";
import { DiscordRetry } from "./discord-api.js";
import { TelegramRequestError, telegramApi } from "./telegram-api.js";
import type {
  ConnectorBinding,
  ConnectorEvent,
  ConnectorProvider,
} from "./types.js";
export interface InboundFile {
  id: string;
  name: string;
  bytes: Uint8Array;
}
export interface InboundFileBudget {
  files: number;
  bytes: number;
}
export const inboundFileBudget = (): InboundFileBudget => ({
  files: 0,
  bytes: 0,
});
/** Keep the existing native attachment ceiling; aggregate input is at most 24 MiB/16 files. */
const FILE_LIMIT = 3_000_000,
  BATCH_LIMIT = 24 * 1024 * 1024;
export class InboundFileUnavailable extends Error {
  constructor() {
    super("Provider attachment is unavailable or unsupported");
  }
}
function unavailable(): never {
  throw new InboundFileUnavailable();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    unavailable();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32)
  )
    unavailable();
  return value;
}
function filename(value: unknown): string {
  const name = identifier(value);
  if (name.length > 240 || name === "." || name === ".." || /[\\/]/.test(name))
    unavailable();
  return name;
}
function size(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > FILE_LIMIT
  )
    unavailable();
  return value as number;
}
function reserve(budget: InboundFileBudget, count: number, bytes: number) {
  if (budget.files + count > 16 || budget.bytes + bytes > BATCH_LIMIT)
    unavailable();
  budget.files += count;
  budget.bytes += bytes;
}
export type InboundFileAdmitter = (
  binding: ConnectorBinding,
  event: ConnectorEvent,
  file: InboundFile,
) => Promise<string> | string;
export type ReplyReferenceResolver = (input: {
  provider: ConnectorProvider;
  accountId: string;
  chatId: string;
  conversationId: string;
  messageId: string;
}) => { nativeMessageId: string } | undefined;
export interface InboundNormalization {
  attachmentIds?: string[];
  resolveReplyReference?: ReplyReferenceResolver;
}
function retry(provider: ConnectorProvider, delay = 5000): never {
  throw provider === "telegram"
    ? new TelegramRequestError(delay)
    : new DiscordRetry(delay);
}
function unknownRetry(): never {
  throw new ConnectorError(
    "unavailable",
    "Provider file retry delay requires operator review",
  );
}
async function download(
  url: string,
  expected: number,
  request: typeof fetch,
  parent: AbortSignal,
  provider: ConnectorProvider,
): Promise<Uint8Array> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(30000)]);
  try {
    signal.throwIfAborted();
    const response = await request(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) {
        const value = response.headers.get("retry-after");
        const seconds =
          value !== null && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400)
          unknownRetry();
        retry(provider, Math.ceil(seconds * 1000));
      }
      if (response.status >= 500) retry(provider);
      unavailable();
    }
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) !== expected)
    )
      unavailable();
    const reader = response.body?.getReader();
    if (!reader) unavailable();
    const chunks: Uint8Array[] = [];
    let actual = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        actual += part.value.byteLength;
        if (actual > expected || actual > FILE_LIMIT) unavailable();
        chunks.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof InboundFileUnavailable) throw error;
      retry(provider);
    } finally {
      reader.releaseLock();
    }
    if (actual !== expected) unavailable();
    return new Uint8Array(Buffer.concat(chunks));
  } catch (error) {
    if (
      error instanceof InboundFileUnavailable ||
      error instanceof ConnectorError
    )
      throw error;
    retry(provider);
  }
}
export async function acquireTelegramFiles(
  message: Record<string, unknown>,
  options: {
    token: string;
    request?: typeof fetch;
    signal: AbortSignal;
    budget: InboundFileBudget;
  },
): Promise<InboundFile[]> {
  const request = options.request ?? fetch,
    api = telegramApi(options.token, request);
  if (["paid_media", "live_photo"].some((k) => k in message)) unavailable();
  const descriptors: Record<string, unknown>[] = [];
  for (const key of [
    "document",
    "audio",
    "video",
    "voice",
    "video_note",
    "animation",
    "sticker",
  ]) {
    if (key in message) descriptors.push(object(message[key]));
  }
  if ("photo" in message) {
    if (
      !Array.isArray(message.photo) ||
      !message.photo.length ||
      message.photo.length > 16
    )
      unavailable();
    const photos = message.photo.map(object);
    for (const photo of photos)
      if (
        !Number.isSafeInteger(photo.width) ||
        !Number.isSafeInteger(photo.height) ||
        (photo.width as number) < 1 ||
        (photo.height as number) < 1
      )
        unavailable();
    descriptors.push(
      photos.sort(
        (a, b) =>
          (b.width as number) * (b.height as number) -
          (a.width as number) * (a.height as number),
      )[0]!,
    );
  }
  if (!descriptors.length || descriptors.length > 16) unavailable();
  const unique = new Map<string, Record<string, unknown>>();
  for (const descriptor of descriptors) {
    const id = identifier(descriptor.file_id);
    if (!unique.has(id)) unique.set(id, descriptor);
  }
  if (options.budget.files + unique.size > 16) unavailable();
  const resolved: { id: string; name: string; path: string; size: number }[] =
    [];
  for (const [id, descriptor] of unique) {
    if (descriptor.file_size !== undefined) size(descriptor.file_size);
    let result: Record<string, unknown>;
    try {
      result = object(await api("getFile", { file_id: id }, options.signal));
    } catch (error) {
      if (error instanceof TelegramRequestError) {
        if (error.httpStatus === 429 && error.retryAfterMs === undefined)
          unknownRetry();
        if (
          error.httpStatus === undefined ||
          error.httpStatus === 429 ||
          error.httpStatus >= 500
        )
          throw error;
      }
      if (
        error instanceof ConnectorError &&
        !(error instanceof TelegramRequestError)
      )
        throw error;
      unavailable();
    }
    const bytes = size(result.file_size),
      path = identifier(result.file_path);
    if (
      result.file_id !== id ||
      (descriptor.file_size !== undefined && descriptor.file_size !== bytes) ||
      (descriptor.file_unique_id !== undefined &&
        descriptor.file_unique_id !== result.file_unique_id) ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path) ||
      path.split("/").some((p) => p === "." || p === "..")
    )
      unavailable();
    resolved.push({
      id,
      name: filename(descriptor.file_name ?? path.split("/").at(-1)),
      path,
      size: bytes,
    });
  }
  reserve(
    options.budget,
    resolved.length,
    resolved.reduce((sum, f) => sum + f.size, 0),
  );
  const result: InboundFile[] = [];
  for (const f of resolved)
    result.push({
      id: f.id,
      name: f.name,
      bytes: await download(
        `https://api.telegram.org/file/bot${options.token}/${f.path}`,
        f.size,
        request,
        options.signal,
        "telegram",
      ),
    });
  return result;
}
export async function acquireDiscordFiles(
  message: Record<string, unknown>,
  options: {
    request?: typeof fetch;
    signal: AbortSignal;
    budget: InboundFileBudget;
  },
): Promise<InboundFile[]> {
  if (
    typeof message.channel_id !== "string" ||
    !/^\d+$/.test(message.channel_id) ||
    !Array.isArray(message.attachments) ||
    !message.attachments.length ||
    message.attachments.length > 16
  )
    unavailable();
  const files = message.attachments.map((value) => {
    const file = object(value),
      id = identifier(file.id),
      name = filename(file.filename),
      bytes = size(file.size);
    if (!/^[1-9][0-9]{0,19}$/.test(id) || file.ephemeral === true)
      unavailable();
    let url: URL;
    try {
      url = new URL(identifier(file.url));
    } catch {
      unavailable();
    }
    const parts = url.pathname.split("/");
    let pathName: string;
    try {
      pathName = decodeURIComponent(parts[4] ?? "");
    } catch {
      unavailable();
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "cdn.discordapp.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      parts.length !== 5 ||
      parts[1] !== "attachments" ||
      parts[2] !== message.channel_id ||
      parts[3] !== id ||
      pathName !== name
    )
      unavailable();
    return { id, name, size: bytes, url: url.href };
  });
  if (new Set(files.map((f) => f.id)).size !== files.length) unavailable();
  reserve(
    options.budget,
    files.length,
    files.reduce((sum, f) => sum + f.size, 0),
  );
  const result: InboundFile[] = [];
  for (const f of files)
    result.push({
      id: f.id,
      name: f.name,
      bytes: await download(
        f.url,
        f.size,
        options.request ?? fetch,
        options.signal,
        "discord",
      ),
    });
  return result;
}
/** Invalid native media is a durable rejection; storage/authority failures remain retryable. */
export async function admitInboundFiles(
  files: InboundFile[],
  binding: ConnectorBinding,
  event: ConnectorEvent,
  admit: InboundFileAdmitter,
  check: () => void,
): Promise<string[] | undefined> {
  const ids: string[] = [];
  for (const file of files) {
    check();
    try {
      ids.push(await admit(binding, event, file));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "invalid")
        return;
      throw error;
    }
    check();
  }
  return ids;
}
