import {
  slackRecipient,
  slackDmPlan,
  sendSlackDm,
  reconcileSlackDm,
} from "./slack-dm-delivery.js";
import { createHash } from "node:crypto";
import type {
  DeliveryOperationReader,
  DeliveryOperationWriter,
  DeliveryOutputReader,
  DeliveryUploadReader,
  DeliveryUploadWriter,
  RoutineExternalDelivery,
  DeliveryReceipt,
  UploadPhase,
} from "@mindi/routines";
import type { SlackDeliveryConfig } from "./routine-delivery-config.js";
import {
  type SlackHttp,
  SlackRateLimitError,
  slackUploadUrl,
} from "./slack-delivery-http.js";
const unknown = () => new Error("Slack file delivery outcome is unknown");
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const ts = (v: unknown): v is string =>
  typeof v === "string" && /^\d{10,20}\.\d{6}$/.test(v);
const refused = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_arguments",
  "missing_argument",
  "no_permission",
  "access_denied",
  "file_type_not_allowed",
  "file_upload_size_restricted",
  "file_uploads_disabled",
  "file_uploads_except_images_disabled",
  "storage_limit_reached",
]);
class Refused extends Error {}
function accepted(value: Record<string, unknown>) {
  if (value.ok === true) return;
  if (
    value.ok === false &&
    typeof value.error === "string" &&
    refused.has(value.error)
  )
    throw new Refused();
  throw unknown();
}
function plan(d: RoutineExternalDelivery, config: SlackDeliveryConfig) {
  const files = d.outputs ?? [];
  if (
    (!files.length && (!d.summary || !slackRecipient(d.target.chatId))) ||
    files.length > 16
  )
    throw unknown();
  return [
    ...(slackRecipient(d.target.chatId) ? [slackDmPlan(config, d)] : []),
    ...(d.summary
      ? [
          {
            key: "slack:text",
            kind: "message" as const,
            payload: JSON.stringify({ text: d.summary, target: d.target }),
          },
        ]
      : []),
    ...files.map((file) => ({
      key: `slack:file:${file.id}`,
      kind: "attachment" as const,
      payload: JSON.stringify({ file, target: d.target }),
    })),
  ];
}
function combined(operations: DeliveryOperationReader): DeliveryReceipt {
  const parts = operations.list();
  if (!parts.length || parts.some((p) => p.state !== "confirmed" || !p.receipt))
    throw unknown();
  return {
    state: "delivered",
    receipt:
      "slack:operations:" +
      createHash("sha256")
        .update(JSON.stringify(parts.map((p) => p.receipt)))
        .digest("hex"),
  };
}
async function shareReceipt(
  http: SlackHttp,
  config: SlackDeliveryConfig,
  d: RoutineExternalDelivery,
  index: number,
  uploads: DeliveryUploadReader,
  signal: AbortSignal,
  physicalChannel: string,
): Promise<string | undefined> {
  const e = uploads.get(index);
  if (
    !e?.fileId ||
    e.workspaceId !== config.teamId ||
    e.actorId !== config.userId
  )
    return;
  const output = d.outputs?.find(
    (f) => `slack:file:${f.id}` === plan(d, config)[index]?.key,
  );
  if (!output) return;
  const value = await http.api("files.info", { file: e.fileId }, signal),
    file = object(value.file);
  if (
    value.ok !== true ||
    !file ||
    file.id !== e.fileId ||
    file.user !== config.userId ||
    file.name !== output.name ||
    file.size !== output.size
  )
    return;
  const shares = object(file.shares);
  if (!shares) return;
  const matches = new Set<string>();
  for (const bucket of ["public", "private"]) {
    const map = object(shares[bucket]);
    if (!map) continue;
    const rows = map[physicalChannel];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > 100) return;
    for (const raw of rows) {
      const share = object(raw);
      if (!share || !ts(share.ts) || share.team_id !== config.teamId) return;
      if (
        d.target.threadId
          ? share.thread_ts !== d.target.threadId
          : share.thread_ts !== undefined && share.thread_ts !== share.ts
      )
        continue;
      matches.add(share.ts);
    }
  }
  if (matches.size !== 1) return;
  return `slack:file:${e.fileId}:${physicalChannel}:${[...matches][0]}`;
}
export async function sendSlackFiles(input: {
  config: SlackDeliveryConfig;
  delivery: RoutineExternalDelivery;
  signal: AbortSignal;
  operations: DeliveryOperationWriter;
  uploads: DeliveryUploadWriter;
  outputs: DeliveryOutputReader;
  http: SlackHttp;
  verify: () => Promise<boolean>;
  sendText: (
    physicalChannel: string,
  ) => Promise<DeliveryReceipt | { state: "rejected"; reason?: "empty_file" }>;
}): Promise<DeliveryReceipt | { state: "rejected"; reason?: "empty_file" }> {
  const {
    config,
    delivery: d,
    signal,
    operations,
    uploads,
    outputs,
    http,
  } = input;
  const specs = plan(d, config),
    contents = new Map<string, Uint8Array>();
  // Preflight the complete immutable result before text or any file effect.
  for (const file of d.outputs ?? []) {
    if (file.size === 0) return { state: "rejected", reason: "empty_file" };
    const value = await outputs.read(file.id);
    contents.set(file.id, value.bytes);
  }
  if (!(await input.verify())) return { state: "rejected" };
  operations.prepare(specs);
  let physicalChannel = d.target.chatId;
  if (slackRecipient(physicalChannel)) {
    const resolved = await sendSlackDm(config, d, operations, http, signal);
    if (!resolved) return { state: "rejected" };
    physicalChannel = resolved;
  }
  for (let index = 0; index < specs.length; index++) {
    const current = operations.list()[index];
    if (!current) throw unknown();
    if (current.state === "confirmed") continue;
    if (current.state !== "pending" && current.state !== "rejected")
      throw unknown();
    if (current.kind === "message") {
      operations.claim(index);
      try {
        const sent = await input.sendText(physicalChannel);
        if (sent.state === "rejected") {
          operations.reject(index);
          return sent;
        }
        operations.confirm(index, sent.receipt);
      } catch (error) {
        if (error instanceof SlackRateLimitError) {
          operations.reject(index);
          return { state: "rejected" };
        }
        throw error;
      }
      continue;
    }
    const file = d.outputs!.find((f) => `slack:file:${f.id}` === current.key)!;
    let entry = uploads.prepare(index, {
      workspaceId: config.teamId,
      actorId: config.userId,
      manifestFingerprint: createHash("sha256")
        .update(specs[index]!.payload)
        .digest("hex"),
    });
    let phase: UploadPhase | undefined;
    try {
      if (entry.allocation !== "acknowledged") {
        phase = "allocation";
        uploads.intent(index, phase);
        const result = await http.api(
          "files.getUploadURLExternal",
          { filename: file.name, length: file.size },
          signal,
        );
        accepted(result);
        if (
          typeof result.file_id !== "string" ||
          !/^F[A-Z0-9]{2,63}$/.test(result.file_id) ||
          typeof result.upload_url !== "string"
        )
          throw unknown();
        entry = uploads.allocated(index, {
          fileId: result.file_id,
          uploadUrl: slackUploadUrl(result.upload_url),
        });
        phase = undefined;
      }
      if (entry.upload !== "acknowledged") {
        phase = "upload";
        uploads.intent(index, phase);
        await http.upload(entry.uploadUrl!, contents.get(file.id)!, signal);
        entry = uploads.uploaded(index);
        phase = undefined;
      }
      if (entry.share !== "acknowledged") {
        phase = "share";
        uploads.intent(index, phase);
        const result = await http.api(
          "files.completeUploadExternal",
          {
            files: [{ id: entry.fileId, title: file.name }],
            channel_id: physicalChannel,
            ...(d.target.threadId ? { thread_ts: d.target.threadId } : {}),
          },
          signal,
        );
        accepted(result);
        if (
          !Array.isArray(result.files) ||
          result.files.length !== 1 ||
          object(result.files[0])?.id !== entry.fileId
        )
          throw unknown();
        phase = undefined;
      }
      const receipt = await shareReceipt(
        http,
        config,
        d,
        index,
        uploads,
        signal,
        physicalChannel,
      );
      if (!receipt) throw unknown();
      uploads.confirm(index, receipt);
    } catch (error) {
      if (
        phase &&
        (error instanceof Refused || error instanceof SlackRateLimitError)
      ) {
        uploads.reject(index, phase);
        return { state: "rejected" };
      }
      throw error;
    }
  }
  return combined(operations);
}
export async function reconcileSlackFiles(input: {
  config: SlackDeliveryConfig;
  delivery: RoutineExternalDelivery;
  signal: AbortSignal;
  operations: DeliveryOperationReader;
  uploads: DeliveryUploadReader;
  http: SlackHttp;
  verify: () => Promise<boolean>;
  findText: (
    physicalChannel: string,
  ) => Promise<DeliveryReceipt | { state: "unknown" }>;
}): Promise<DeliveryReceipt | { state: "unknown" }> {
  const { config, delivery: d, signal, operations, uploads, http } = input;
  if (!(await input.verify())) return { state: "unknown" };
  const expected = plan(d, config),
    parts = operations.list();
  if (
    parts.length !== expected.length ||
    parts.some(
      (p, i) =>
        p.key !== expected[i]!.key ||
        p.kind !== expected[i]!.kind ||
        p.payload !== expected[i]!.payload,
    )
  )
    return { state: "unknown" };
  let physicalChannel = d.target.chatId;
  if (slackRecipient(physicalChannel)) {
    const resolved = await reconcileSlackDm(
      config,
      d,
      operations,
      http,
      signal,
    );
    if (!resolved) return { state: "unknown" };
    physicalChannel = resolved;
  }
  for (let index = 0; index < parts.length; index++) {
    const part = operations.list()[index]!;
    if (part.state === "confirmed") continue;
    if (!["sending", "uncertain"].includes(part.state))
      return { state: "unknown" };
    if (part.kind === "message") {
      const found = await input.findText(physicalChannel);
      if (found.state !== "delivered") return found;
      operations.confirm(index, found.receipt);
    } else {
      const found = await shareReceipt(
        http,
        config,
        d,
        index,
        uploads,
        signal,
        physicalChannel,
      );
      if (!found) return { state: "unknown" };
      uploads.confirm(index, found);
    }
  }
  return combined(operations);
}
