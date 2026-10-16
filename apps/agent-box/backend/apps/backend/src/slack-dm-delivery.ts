import type {
  DeliveryOperationReader,
  DeliveryOperationWriter,
  RoutineExternalDelivery,
} from "@mindi/routines";
import type { SlackDeliveryConfig } from "./routine-delivery-config.js";
import { SlackRateLimitError, type SlackHttp } from "./slack-delivery-http.js";
export const slackRecipient = (id: string) => /^[UW][A-Z0-9]{2,63}$/.test(id);
const unknown = () => new Error("Slack conversation outcome is unknown");
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export function slackDmPlan(
  config: SlackDeliveryConfig,
  d: RoutineExternalDelivery,
) {
  return {
    key: "slack:dm",
    kind: "conversation" as const,
    payload: JSON.stringify({
      bindingId: d.target.bindingId,
      bindingRevision: d.target.bindingRevision,
      teamId: config.teamId,
      actorId: config.userId,
      recipient: d.target.chatId,
    }),
  };
}
function channel(value: unknown, recipient: string): string | undefined {
  const row = object(value);
  if (
    row?.is_im !== true ||
    row.user !== recipient ||
    typeof row.id !== "string" ||
    !/^D[A-Z0-9]{2,63}$/.test(row.id)
  )
    return;
  return row.id;
}
function receipt(
  config: SlackDeliveryConfig,
  d: RoutineExternalDelivery,
  id: string,
) {
  return `slack:dm:${config.teamId}:${config.userId}:${d.target.chatId}:${id}`;
}
async function info(
  http: SlackHttp,
  recipient: string,
  id: string,
  signal: AbortSignal,
) {
  const value = await http.api("conversations.info", { channel: id }, signal);
  return value.ok === true && channel(value.channel, recipient) === id;
}
function saved(
  config: SlackDeliveryConfig,
  d: RoutineExternalDelivery,
  operations: DeliveryOperationReader,
) {
  const op = operations.list()[0],
    expected = slackDmPlan(config, d);
  if (
    !op ||
    op.key !== expected.key ||
    op.kind !== expected.kind ||
    op.payload !== expected.payload
  )
    throw unknown();
  return op;
}
export async function sendSlackDm(
  config: SlackDeliveryConfig,
  d: RoutineExternalDelivery,
  operations: DeliveryOperationWriter,
  http: SlackHttp,
  signal: AbortSignal,
): Promise<string | undefined> {
  const op = saved(config, d, operations);
  if (op.state === "confirmed") {
    const id = op.receipt?.split(":").at(-1);
    if (
      !id ||
      op.receipt !== receipt(config, d, id) ||
      !(await info(http, d.target.chatId, id, signal))
    )
      throw unknown();
    return id;
  }
  if (op.state !== "pending" && op.state !== "rejected") throw unknown();
  operations.claim(0);
  let result: Record<string, unknown>;
  try {
    result = await http.api(
      "conversations.open",
      { users: d.target.chatId, return_im: true },
      signal,
    );
  } catch (error) {
    if (error instanceof SlackRateLimitError) {
      operations.reject(0);
      return;
    }
    throw error;
  }
  if (
    result.ok === false &&
    typeof result.error === "string" &&
    new Set([
      "missing_scope",
      "invalid_auth",
      "not_authed",
      "token_revoked",
      "token_expired",
      "account_inactive",
      "user_not_found",
      "user_not_visible",
      "cannot_dm_bot",
      "cannot_dm_self",
      "invalid_arguments",
      "no_permission",
      "restricted_action",
    ]).has(result.error)
  ) {
    operations.reject(0);
    return;
  }
  const id =
    result.ok === true ? channel(result.channel, d.target.chatId) : undefined;
  if (!id) throw unknown();
  operations.confirm(0, receipt(config, d, id));
  if (!(await info(http, d.target.chatId, id, signal))) throw unknown();
  return id;
}
export async function reconcileSlackDm(
  config: SlackDeliveryConfig,
  d: RoutineExternalDelivery,
  operations: DeliveryOperationReader,
  http: SlackHttp,
  signal: AbortSignal,
): Promise<string | undefined> {
  const op = saved(config, d, operations);
  if (op.state === "confirmed") {
    const id = op.receipt?.split(":").at(-1);
    return id &&
      op.receipt === receipt(config, d, id) &&
      (await info(http, d.target.chatId, id, signal))
      ? id
      : undefined;
  }
  if (op.state !== "sending" && op.state !== "uncertain") return;
  const matches = new Set<string>(),
    seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await http.api(
      "conversations.list",
      {
        types: "im",
        limit: 100,
        exclude_archived: false,
        ...(cursor ? { cursor } : {}),
      },
      signal,
    );
    if (
      result.ok !== true ||
      !Array.isArray(result.channels) ||
      result.channels.length > 100
    )
      return;
    for (const raw of result.channels) {
      const row = object(raw);
      if (row?.user === d.target.chatId) {
        const id = channel(raw, d.target.chatId);
        if (!id) return;
        matches.add(id);
      }
    }
    const next = object(result.response_metadata)?.next_cursor;
    if (typeof next !== "string" || next.length > 2048) return;
    if (!next) {
      if (matches.size !== 1) return;
      const id = [...matches][0]!;
      if (!(await info(http, d.target.chatId, id, signal))) return;
      operations.confirm(0, receipt(config, d, id));
      return id;
    }
    if (seen.has(next)) return;
    seen.add(next);
    cursor = next;
  }
}
