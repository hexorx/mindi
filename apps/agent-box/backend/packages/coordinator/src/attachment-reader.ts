import { RuntimeError, type ResolvedAttachment } from "@mindi/agent-runtime";
import { verifiedAttachmentBytes } from "@mindi/omp/attachments";

/** The closure owns immutable bytes; model input can select only an admitted ID and bounded range. */
export function attachmentReader(
  attachments: readonly ResolvedAttachment[] | undefined,
  resolveHistorical?: (id: string) => ResolvedAttachment,
) {
  const files = new Map(
    verifiedAttachmentBytes(attachments).map((file) => [
      file.attachment.id,
      file,
    ]),
  );
  return (args: Record<string, unknown>) => {
    if (
      Object.keys(args).some(
        (key) => !["attachmentId", "offset", "length"].includes(key),
      ) ||
      typeof args.attachmentId !== "string"
    )
      throw new RuntimeError("invalid", "Invalid attachment read request");
    const file =
      files.get(args.attachmentId) ??
      (resolveHistorical
        ? verifiedAttachmentBytes([resolveHistorical(args.attachmentId)])[0]
        : undefined);
    if (file && file.attachment.id !== args.attachmentId)
      throw new RuntimeError(
        "conflict",
        "Historical attachment identity mismatch",
      );
    if (!file)
      throw new RuntimeError(
        "not_found",
        "Attachment is not admitted to this run",
      );
    const offset = args.offset === undefined ? 0 : args.offset;
    const length = args.length === undefined ? 16384 : args.length;
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > file.bytes.length ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > 16384
    )
      throw new RuntimeError("invalid", "Invalid attachment byte range");
    const end = Math.min(file.bytes.length, offset + length);
    const { id, name, mediaType, size, sha256 } = file.attachment;
    return {
      id,
      name,
      mediaType,
      size,
      sha256,
      encoding: "base64",
      offset,
      data: file.bytes.subarray(offset, end).toString("base64"),
      nextOffset: end < file.bytes.length ? end : null,
    };
  };
}
