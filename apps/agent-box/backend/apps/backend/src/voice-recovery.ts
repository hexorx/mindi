import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { acquireDesktopOwnership } from "@mindi/desktop";

/** Offline-only operator acknowledgement; never guesses whether a paid remote session ended. */
export function reconcileVoiceReservation(
  stateRoot: string,
  confirmedStopped: boolean,
  reason: string,
): void {
  if (!confirmedStopped || !reason.trim() || reason.length > 2000)
    throw new Error("Confirm the remote session ended and provide a reason");
  const path = join(resolve(stateRoot), "voice.sqlite");
  if (!statSync(path).isFile()) throw new Error("Voice state does not exist");
  const release = acquireDesktopOwnership(
    join(resolve(stateRoot), "application-ownership.sqlite"),
  );
  try {
    const db = new DatabaseSync(path);
    try {
      db.exec("BEGIN IMMEDIATE");
      const previous = db
        .prepare("SELECT value FROM voice_meta WHERE key='call'")
        .get();
      if (previous) {
        db.prepare(
          "INSERT OR REPLACE INTO voice_meta(key,value) VALUES('manualReconciliation',?)",
        ).run(
          JSON.stringify({
            at: new Date().toISOString(),
            reason,
            previous: JSON.parse(String(previous.value)),
          }),
        );
        db.prepare("DELETE FROM voice_meta WHERE key='call'").run();
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  } finally {
    release();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (!process.argv[2]) throw new Error("Missing state directory");
    reconcileVoiceReservation(
      process.argv[2],
      process.argv[3] === "--confirm-provider-stopped",
      process.argv[4] ?? "",
    );
    process.stdout.write(
      "Voice reservation reconciled; conversation history preserved.\n",
    );
  } catch {
    process.stderr.write(
      "Reconciliation refused. Stop the backend, confirm the provider session ended, and supply STATE_ROOT --confirm-provider-stopped REASON.\n",
    );
    process.exitCode = 1;
  }
}
