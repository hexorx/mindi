import type {
  ConnectorReplyInput,
  ConnectorReplyOperationSpec,
  ConnectorReplyReceipt,
} from "./types.js";
import { object, id, invalid } from "./validation.js";
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    invalid("Invalid reply text");
  return value;
}
export function reply(input: unknown): ConnectorReplyInput {
  const row = object(input, [
    "nativeMessageId",
    "nativeDeliveryId",
    "runId",
    "replyMessageId",
    "text",
    "files",
  ]);
  if (!Array.isArray(row.files) || row.files.length > 32)
    invalid("Invalid reply files");
  const files = Array.from(row.files, (input) => {
    const file = object(input, ["id", "name", "mediaType", "size", "sha256"]);
    if (
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      (file.size as number) > 100 * 1024 * 1024 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      invalid("Invalid reply file metadata");
    const name = id(file.name),
      mediaType = id(file.mediaType);
    if (
      name.includes("/") ||
      name.includes("\\") ||
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mediaType)
    )
      invalid("Invalid reply file name or media type");
    return {
      id: id(file.id),
      name,
      mediaType,
      size: file.size as number,
      sha256: file.sha256,
    };
  });
  if (new Set(files.map((file) => file.id)).size !== files.length)
    invalid("Duplicate reply file");
  return {
    nativeMessageId: id(row.nativeMessageId),
    nativeDeliveryId: id(row.nativeDeliveryId),
    runId: id(row.runId),
    ...(row.replyMessageId !== undefined
      ? { replyMessageId: id(row.replyMessageId) }
      : {}),
    text: text(row.text, 1000000),
    files,
  };
}
export function operation(input: unknown): ConnectorReplyOperationSpec {
  const row = object(input, ["id", "kind", "text", "fileId"]);
  if (row.kind === "text" && !("fileId" in row)) {
    const value = text(row.text, 32000);
    if (!value.length) invalid("Empty reply text operation");
    return { id: id(row.id), kind: "text", text: value };
  }
  if (row.kind === "file" && !("text" in row))
    return { id: id(row.id), kind: "file", fileId: id(row.fileId) };
  invalid("Invalid reply operation");
}
export function receipt(input: unknown): ConnectorReplyReceipt {
  const row = object(input, [
    "provider",
    "accountId",
    "chatId",
    "conversationId",
    "messageId",
  ]);
  if (row.provider !== "telegram" && row.provider !== "discord")
    invalid("Invalid reply receipt provider");
  return {
    provider: row.provider,
    accountId: id(row.accountId),
    chatId: id(row.chatId),
    conversationId: id(row.conversationId),
    messageId: id(row.messageId),
  };
}
