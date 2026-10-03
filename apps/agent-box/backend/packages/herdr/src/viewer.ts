import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TranscriptStore } from "./transcript.js";

export interface ViewerOptions {
  store: TranscriptStore;
  id: string;
  paneId: string;
  signal: AbortSignal;
  write: (text: string) => void;
  report: (args: string[]) => Promise<unknown>;
}
/** Canonical text remains in the journal; terminal control bytes never reach the pane. */
function safeText(text: string): string {
  return [...text]
    .filter(
      (char) =>
        char === "\n" ||
        char === "\t" ||
        (char.codePointAt(0)! >= 32 &&
          !(char.codePointAt(0)! >= 127 && char.codePointAt(0)! <= 159)),
    )
    .join("");
}
export async function runTranscriptViewer(
  options: ViewerOptions,
): Promise<void> {
  if (!/^w\d+:p\d+$/.test(options.paneId)) throw Error("Invalid owned pane");
  let cursor = 0;
  const authority = [
    "--source",
    "custom:mindi-claude",
    "--agent",
    "mindi-claude",
  ];
  try {
    while (!options.signal.aborted) {
      const projection = await options.store.read(options.id, cursor);
      for (const { event } of projection.events) {
        if (event.type === "text") options.write(safeText(event.text));
        else if (event.type !== "session")
          options.write(
            `\n[${event.type}${"message" in event && event.message ? ": " + safeText(event.message) : ""}]\n`,
          );
      }
      if (projection.lastSeq !== cursor) {
        cursor = projection.lastSeq;
        const state =
          projection.status === "blocked"
            ? "blocked"
            : ["completed", "cancelled", "failed", "interrupted"].includes(
                  projection.status,
                )
              ? "idle"
              : "working";
        await options.report([
          "pane",
          "report-agent",
          options.paneId,
          ...authority,
          "--state",
          state,
          "--seq",
          String(cursor),
        ]);
      }
      if (!options.signal.aborted)
        await delay(100, undefined, { signal: options.signal }).catch(
          (error) => {
            if (!options.signal.aborted) throw error;
          },
        );
    }
  } finally {
    await options.report([
      "pane",
      "release-agent",
      options.paneId,
      ...authority,
      "--seq",
      String(cursor + 1),
    ]);
  }
}

export function viewerContext(
  env: NodeJS.ProcessEnv,
  pane: string,
  session: string,
): { binary: string } {
  if (
    env.HERDR_ENV !== "1" ||
    env.HERDR_PANE_ID !== pane ||
    env.HERDR_SESSION !== session ||
    !/^w\d+:p\d+$/.test(pane) ||
    !/^mindi-[a-f0-9]{8}$/.test(session) ||
    !env.HERDR_BIN_PATH ||
    !isAbsolute(env.HERDR_BIN_PATH)
  )
    throw Error("Viewer requires its owned Herdr pane context");
  return { binary: env.HERDR_BIN_PATH };
}
async function main() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1]) throw Error("Missing viewer argument");
    return args[index + 1]!;
  };
  const paneId = get("--pane"),
    session = get("--session");
  const { binary } = viewerContext(process.env, paneId, session);
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const execute = promisify(execFile);
  await runTranscriptViewer({
    store: new TranscriptStore(get("--root")),
    id: get("--id"),
    paneId,
    signal: controller.signal,
    write: (text) => {
      process.stdout.write(text);
    },
    report: (args) =>
      execute(binary, ["--session", session, ...args], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
