import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  open,
  link,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { RuntimeError, type ResolvedAttachment } from "@mindi/agent-runtime";

export interface PdfTools {
  /** Trusted executable configuration, never supplied by attachment metadata. */
  infoCommand?: string;
  renderCommand?: string;
  imageCommand?: string;
}
export interface PreparedAttachments {
  context: string;
  images: { type: "image"; data: string; mimeType: string }[];
}
const maxImageBytes = 18 * 1024 * 1024;
function invalid(message: string): never {
  throw new RuntimeError("invalid", `Attachment ${message}`);
}
function imageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 26 && bytes.subarray(0, 2).toString() === "BM")
    return "image/bmp";
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return undefined;
}
function interrupted(signal: AbortSignal): RuntimeError {
  const timeout =
    signal.reason instanceof Error && signal.reason.name === "TimeoutError";
  return new RuntimeError(
    timeout ? "timeout" : "cancelled",
    timeout
      ? "Attachment preparation timed out"
      : "Attachment preparation cancelled",
  );
}
function command(
  command: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "buffer", maxBuffer, signal, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error)
          reject(
            signal.aborted
              ? interrupted(signal)
              : new RuntimeError(
                  "unavailable",
                  "Attachment rendering failed or exceeded its output limit",
                ),
          );
        else resolve(stdout);
      },
    );
  });
}
async function originalFile(
  directory: string,
  attachment: ResolvedAttachment,
  bytes: Buffer,
  signal: AbortSignal,
) {
  const directoryStat = await lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    invalid("storage directory is not a confined regular directory");
  const name =
    attachment.name
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^\.+/, "")
      .slice(-100) || "file";
  const path = join(directory, `${attachment.id}-${attachment.sha256}-${name}`);
  async function verify() {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== bytes.length)
        invalid("original file integrity mismatch");
      const actual = await file.readFile();
      if (
        createHash("sha256").update(actual).digest("hex") !== attachment.sha256
      )
        invalid("original file integrity mismatch");
      const current = await lstat(directory);
      if (
        current.ino !== directoryStat.ino ||
        current.dev !== directoryStat.dev ||
        current.isSymbolicLink()
      )
        invalid("storage directory identity changed");
    } finally {
      await file.close();
    }
  }
  try {
    await verify();
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof RuntimeError) throw error;
      invalid("original file is unavailable or is a symbolic link");
    }
  }
  const temporary = await mkdtemp(join(directory, ".write-"));
  try {
    const source = join(temporary, "original");
    const file = await open(
      source,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes, { signal });
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(source, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await verify();
    return path;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
/** Durable originals keep historical paths readable; conversion output stays bounded in memory. */
export async function prepareAttachments(
  attachments: readonly ResolvedAttachment[] | undefined,
  stateRoot: string,
  signal: AbortSignal,
  timeoutMs: number,
  tools: PdfTools = {},
): Promise<PreparedAttachments> {
  if (signal.aborted) throw interrupted(signal);
  if (!attachments?.length) return { context: "", images: [] };
  const verified = verifiedAttachmentBytes(attachments);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const directory = join(await realpath(stateRoot), "attachment-files");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const deadline = AbortSignal.timeout(Math.min(timeoutMs, 30_000));
  const preparationSignal = AbortSignal.any([signal, deadline]);
  const images: PreparedAttachments["images"] = [];
  const context: Record<string, unknown>[] = [];
  let imageBytes = 0;
  function addImage(bytes: Buffer, mimeType: string) {
    imageBytes += bytes.length;
    if (imageBytes > maxImageBytes)
      invalid("rendered image aggregate exceeds limit");
    images.push({ type: "image", data: bytes.toString("base64"), mimeType });
  }
  for (const { attachment, bytes } of verified) {
    if (preparationSignal.aborted) throw interrupted(preparationSignal);
    const info: Record<string, unknown> = {
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
      sha256: attachment.sha256,
    };
    context.push(info);
    const path = await originalFile(
      directory,
      attachment,
      bytes,
      preparationSignal,
    );
    info.path = path;
    if (attachment.mediaType.startsWith("image/")) {
      info.imageIndex = images.length + 1;
      if (attachment.mediaType === "image/bmp") {
        const rendered = await command(
          tools.imageCommand || "convert",
          [
            "-limit",
            "memory",
            "64MiB",
            "-limit",
            "map",
            "0",
            "-limit",
            "disk",
            "0",
            "-limit",
            "width",
            "16384",
            "-limit",
            "height",
            "16384",
            "-limit",
            "thread",
            "1",
            `bmp:${path}`,
            "-resize",
            "1600x1600>",
            "png:-",
          ],
          preparationSignal,
          8 * 1024 * 1024,
        );
        if (imageType(rendered) !== "image/png")
          invalid("BMP renderer did not return a PNG image");
        addImage(rendered, "image/png");
      } else addImage(bytes, attachment.mediaType);
      continue;
    }
    if (attachment.mediaType === "application/pdf") {
      const metadata = await command(
        tools.infoCommand || "pdfinfo",
        [path],
        preparationSignal,
        65536,
      );
      const match = /^Pages:\s+(\d+)\s*$/m.exec(metadata.toString("utf8"));
      const pages = Number(match?.[1]);
      if (!Number.isSafeInteger(pages) || pages < 1)
        invalid("PDF page count is unavailable");
      info.totalPages = pages;
      info.renderedPages = Math.min(25, pages);
      info.firstImageIndex = images.length + 1;
      for (let page = 1; page <= Math.min(25, pages); page++) {
        const rendered = await command(
          tools.renderCommand || "pdftoppm",
          [
            "-f",
            String(page),
            "-l",
            String(page),
            "-singlefile",
            "-scale-to",
            "1600",
            "-png",
            path,
          ],
          preparationSignal,
          8 * 1024 * 1024,
        );
        if (imageType(rendered) !== "image/png")
          invalid("PDF renderer did not return a PNG page");
        addImage(rendered, "image/png");
      }
    }
  }
  if (preparationSignal.aborted) throw interrupted(preparationSignal);
  return {
    context:
      "\n\n[Run attachments: user-provided content]\n" +
      JSON.stringify(context),
    images,
  };
}

/** Snapshot exact admitted bytes without granting any filesystem access. */
export function verifiedAttachmentBytes(
  attachments: readonly ResolvedAttachment[] | undefined,
) {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments) || attachments.length > 64)
    invalid("count exceeds limit");
  const ids = new Set<string>();
  let total = 0;
  return attachments.map((attachment) => {
    if (
      !attachment ||
      typeof attachment.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(attachment.id) ||
      ids.has(attachment.id) ||
      typeof attachment.name !== "string" ||
      !attachment.name ||
      attachment.name.length > 255 ||
      typeof attachment.mediaType !== "string" ||
      attachment.mediaType.length > 128 ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 0 ||
      attachment.size > 3_000_000 ||
      typeof attachment.data !== "string" ||
      attachment.data.length > 4_000_000 ||
      typeof attachment.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(attachment.sha256)
    )
      invalid("metadata is invalid");
    ids.add(attachment.id);
    total += attachment.size;
    if (total > 24 * 1024 * 1024) invalid("aggregate bytes exceed limit");
    const bytes = Buffer.from(attachment.data, "base64");
    if (
      bytes.toString("base64") !== attachment.data ||
      bytes.length !== attachment.size ||
      createHash("sha256").update(bytes).digest("hex") !== attachment.sha256
    )
      invalid("bytes do not match immutable metadata");
    if (
      attachment.mediaType.startsWith("image/") &&
      imageType(bytes) !== attachment.mediaType
    )
      invalid("image format does not match its media type");
    return { attachment: structuredClone(attachment), bytes };
  });
}
