import type { DatabaseSync } from "node:sqlite";
import { RuntimeError } from "@mindi/agent-runtime";
export interface TranscriptPageInput {
  before?: number;
  after?: number;
  limit?: number;
}
export interface SpokenFragment {
  sequence: number;
  callId: string;
  role: "user" | "assistant";
  text: string;
  start: number;
  end: number;
}
export function transcriptPage(
  db: DatabaseSync,
  input: TranscriptPageInput = {},
) {
  const { before, after, limit = 100 } = input;
  if (
    Object.keys(input).some(
      (key) => !["before", "after", "limit"].includes(key),
    ) ||
    (before !== undefined && after !== undefined) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    [before, after].some(
      (cursor) =>
        cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1),
    )
  )
    throw new RuntimeError("invalid", "Invalid transcript page");
  const incremental = after !== undefined;
  const rows = db
    .prepare(
      `SELECT seq,call_id,value FROM voice_transcripts
    ${before !== undefined ? "WHERE seq<?" : incremental ? "WHERE seq>?" : ""}
    ORDER BY seq ${incremental ? "ASC" : "DESC"} LIMIT ?`,
    )
    .all(
      ...(before !== undefined ? [before] : incremental ? [after] : []),
      limit + 1,
    );
  const items: SpokenFragment[] = [];
  // Reserve the complete envelope with the largest valid cursor values.
  let bytes = Buffer.byteLength(
    JSON.stringify({
      items: [],
      nextBefore: Number.MAX_SAFE_INTEGER,
      nextAfter: Number.MAX_SAFE_INTEGER,
    }),
  );
  for (const row of rows.slice(0, limit)) {
    const value = JSON.parse(String(row.value)) as Omit<
      SpokenFragment,
      "sequence" | "callId"
    >;
    const item: SpokenFragment = {
      sequence: Number(row.seq),
      callId: String(row.call_id),
      role: value.role,
      text: value.text,
      start: value.start,
      end: value.end,
    };
    const size =
      Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
    if (bytes + size > 256 * 1024) {
      if (!items.length)
        throw new RuntimeError(
          "invalid",
          "Transcript fragment exceeds page limit",
        );
      break;
    }
    bytes += size;
    items.push(item);
  }
  const more = rows.length > items.length;
  if (!incremental) items.reverse();
  return {
    items,
    nextBefore: !incremental && more ? items[0]!.sequence : null,
    nextAfter: incremental && more ? items.at(-1)!.sequence : null,
  };
}
