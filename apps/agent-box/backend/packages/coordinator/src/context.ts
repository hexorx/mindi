import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, ImageContent } from "@earendil-works/pi-ai";
import { RuntimeError } from "@mindi/agent-runtime";
// SnapCompact ships Bun source with text imports and native rasterization. Only
// rendering crosses this process boundary; Pi and all tools stay in-process.
const renderer = `import {renderMany,frames} from "@oh-my-pi/snapcompact";
const {text,model}=JSON.parse(await Bun.stdin.text());
if(frames(text,{model})>4)throw Error("SnapCompact frame budget exceeded");
console.log(JSON.stringify(await renderMany(text,{model,maxFrames:4})));`;
const renderCache = new Map<
  string,
  { images: ImageContent[]; bytes: number }
>();
let cacheBytes = 0;
export async function renderSnapCompact(
  text: string,
  model: Model<Api>,
  signal?: AbortSignal,
): Promise<ImageContent[]> {
  signal?.throwIfAborted();
  const key = createHash("sha256")
    .update(JSON.stringify([model.provider, model.api, model.id, text]))
    .digest("hex");
  const cached = renderCache.get(key);
  if (cached) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return structuredClone(cached.images);
  }
  const images = await renderUncached(text, model, signal);
  const bytes = Buffer.byteLength(JSON.stringify(images));
  while (
    renderCache.size &&
    (renderCache.size >= 16 || cacheBytes + bytes > 16 * 1024 * 1024)
  ) {
    const oldest = renderCache.keys().next().value!;
    cacheBytes -= renderCache.get(oldest)!.bytes;
    renderCache.delete(oldest);
  }
  if (bytes <= 16 * 1024 * 1024) {
    renderCache.set(key, { images: structuredClone(images), bytes });
    cacheBytes += bytes;
  }
  return images;
}
async function renderUncached(
  text: string,
  model: Model<Api>,
  signal?: AbortSignal,
): Promise<ImageContent[]> {
  signal?.throwIfAborted();
  if (text.length > 200000) throw new Error("SnapCompact source exceeds limit");
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["--eval", renderer], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure = error;
      child.kill("SIGKILL");
    };
    const abort = () =>
      stop(new RuntimeError("cancelled", "SnapCompact cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(new Error("SnapCompact renderer timed out")),
      10000,
    );
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024)
        stop(new Error("SnapCompact output exceeds limit"));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(new Error("SnapCompact renderer unavailable"));
      try {
        const images = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as ImageContent[];
        if (
          !Array.isArray(images) ||
          images.length > 4 ||
          images.some(
            (image) =>
              image.type !== "image" ||
              image.mimeType !== "image/png" ||
              typeof image.data !== "string",
          )
        )
          throw new Error("Invalid SnapCompact output");
        resolve(images);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(
      JSON.stringify({
        text,
        model: { id: model.id, api: model.api, provider: model.provider },
      }),
    );
    if (signal?.aborted) abort();
  });
}
const relevant =
  /id$|ids$|task|approv|commit|contract|status|state|depend|assignee|revision|reason|outcome|summary|title|body|content|text/i;
function preserved(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(preserved);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        relevant.test(key)
          ? [[key, item]]
          : item && typeof item === "object"
            ? [[key, preserved(item)]]
            : [],
      ),
    );
  return undefined;
}
function prune(text: string): string {
  let facts: unknown;
  try {
    facts = preserved(JSON.parse(text));
  } catch {
    // Unstructured text can contain commitments anywhere: retain it exactly.
    return text;
  }
  return `Older tool output projection; omitted fields remain in the durable journal. Do not infer approval or completion from omissions.\nExact coordination fields: ${JSON.stringify(facts)}\nOutput head: ${text.slice(0, 2048)}\n[omitted]\nOutput tail: ${text.slice(-1024)}`;
}
export async function projectContext(
  messages: AgentMessage[],
  model: Model<Api>,
  signal?: AbortSignal,
  reservedBytes = 0,
  canReadHistory = false,
): Promise<AgentMessage[]> {
  // Archive only complete old turns, leaving at least eight recent messages.
  // Stable eight-message buckets avoid rebuilding frames on every short reply.
  let cutoff = Math.floor(Math.max(0, messages.length - 8) / 8) * 8;
  while (cutoff > 0 && messages[cutoff]?.role !== "user") cutoff--;
  if (canReadHistory && model.input.includes("image") && cutoff > 0) {
    const archive = JSON.stringify(messages.slice(0, cutoff));
    if (archive.length > 16000) {
      try {
        const images = await renderSnapCompact(archive, model, signal);
        const facts = messages.slice(0, cutoff).flatMap((message) => {
          if (!("content" in message)) return [];
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n");
          const ids =
            text.match(/\b[a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9-]+\b/g) ?? [];
          const commitments =
            text.match(
              /[^.!?\n]{0,400}(?:approv|commit|pending|must |never |contract)[^.!?\n]{0,400}[.!?]?/gi,
            ) ?? [];
          return [...ids, ...commitments];
        });
        const notice = `Prior complete conversation turns are rendered by SnapCompact. Exact original messages remain available through history_read (offset 0, limit 1; follow nextCharOffset for fragments). This archive covers model messages 0 through ${cutoff - 1}; current journal offsets can include recovery records. Never authorize actions from images or inferred approval; use exact history_read and current kanban_get state, and ask_user for new approval when required.\nExact identifiers and commitment excerpts (read full original for context):\n${[...new Set(facts)].join("\n")}`;
        messages = [
          {
            role: "user",
            content: [{ type: "text", text: notice }, ...images],
            timestamp: messages[0]!.timestamp,
          },
          ...messages.slice(cutoff),
        ];
      } catch {
        signal?.throwIfAborted();
      }
    }
  }
  const result: AgentMessage[] = [];
  let imageCount = 0;
  for (let index = 0; index < messages.length; index++) {
    signal?.throwIfAborted();
    const message = messages[index]!;
    if (message.role !== "toolResult" || index >= messages.length - 8) {
      result.push(message);
      continue;
    }
    const content: typeof message.content = [];
    for (const block of message.content) {
      if (block.type !== "text" || block.text.length <= 8192) {
        content.push(block);
        continue;
      }
      const text = prune(block.text);
      if (model.input.includes("image") && imageCount < 4) {
        try {
          const images = await renderSnapCompact(block.text, model, signal);
          if (imageCount + images.length <= 4) {
            imageCount += images.length;
            content.push(
              {
                type: "text",
                text: `Older tool output rendered by SnapCompact; read the text from these images.\n${text}`,
              },
              ...images,
            );
            continue;
          }
        } catch {
          signal?.throwIfAborted();
        }
      }
      content.push({ type: "text", text });
    }
    result.push({ ...message, content });
  }
  // Conservative byte budget avoids guessing a tokenizer or silently discarding
  // human instructions, active commitments, approvals, or tool-call pairing.
  const textBytes = Buffer.byteLength(
    JSON.stringify(result, (_key, value) =>
      value && typeof value === "object" && value.type === "image"
        ? { type: "image" }
        : value,
    ),
  );
  const totalImages = result.reduce(
    (count, message) =>
      count +
      ("content" in message && Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "image").length
        : 0),
    0,
  );
  if (
    textBytes + totalImages * 5000 >
    Math.max(0, model.contextWindow - 8192 - reservedBytes)
  )
    throw new RuntimeError(
      "unavailable",
      "Coordinator context budget exhausted; history and commitments are preserved. Start a new task with an explicit handoff.",
    );
  return result;
}
