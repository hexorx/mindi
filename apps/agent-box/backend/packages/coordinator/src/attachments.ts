import { RuntimeError, type WorkerInput } from "@mindi/agent-runtime";
import { prepareAttachments } from "@mindi/omp/attachments";

/** Reuse immutable-byte validation and image/PDF conversion; Pi has no filesystem reader. */
export async function prepareCoordinatorAttachments(
  input: WorkerInput,
  stateRoot: string,
) {
  const prepared = await prepareAttachments(
    input.attachments,
    stateRoot,
    input.signal,
    30000,
  );
  const canRead =
    input.profile.tools === undefined ||
    input.profile.tools.includes("attachment_read");
  const textFiles: Array<{ id: string; name: string; content: string }> = [];
  let textBytes = 0;
  for (const file of input.attachments ?? []) {
    if (
      file.mediaType.startsWith("image/") ||
      file.mediaType === "application/pdf"
    )
      continue;
    if (
      !file.mediaType.startsWith("text/") &&
      file.mediaType !== "application/json"
    ) {
      if (canRead) continue;
      throw new RuntimeError(
        "invalid",
        "Coordinator attachments support text, JSON, images and PDF; this file type requires a specialist or the attachment_read grant.",
      );
    }
    const bytes = Buffer.from(file.data, "base64");
    if (textBytes + bytes.length > 192000) {
      if (canRead) continue;
      throw new RuntimeError(
        "invalid",
        "Coordinator attachment text exceeds 192000 bytes; use a smaller excerpt or grant attachment_read.",
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      if (canRead) continue;
      throw new RuntimeError(
        "invalid",
        "Coordinator text attachments must contain valid UTF-8.",
      );
    }
    textBytes += bytes.length;
    textFiles.push({ id: file.id, name: file.name, content });
  }
  return {
    ...prepared,
    context:
      prepared.context +
      (canRead && input.attachments?.length
        ? "\nUse attachment_read with an admitted attachment ID and byte offset to inspect exact file bytes not included inline. Follow nextOffset until null; data is base64, not interpreted text. It reads this run’s admitted files and verified prior conversation admissions, and accepts no filesystem paths. Use history_read to recover earlier attachment IDs. Unsupported document interpretation requires a specialist; never claim the file was understood from its metadata alone."
        : "") +
      (textFiles.length
        ? "\n[User-provided attachment text]\n" + JSON.stringify(textFiles)
        : ""),
  };
}
