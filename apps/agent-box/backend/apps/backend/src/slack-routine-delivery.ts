import { slackRecipient } from "./slack-dm-delivery.js";
import {
  createSlackHttp,
  type SlackMethod,
  SlackRateLimitError,
} from "./slack-delivery-http.js";
import { sendSlackFiles, reconcileSlackFiles } from "./slack-file-delivery.js";
import type { DeliveryUploadReader } from "@mindi/routines";
import { createHash } from "node:crypto";
import type {
  DeliveryAddress,
  RoutineDeliveryAdapter,
  RoutineExternalDelivery,
} from "@mindi/routines";
import type { SlackDeliveryConfig } from "./routine-delivery-config.js";
const unknown = () => new Error("Slack delivery outcome is unknown");
const channel = (value: string) => /^[CGD][A-Z0-9]{2,63}$/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && /^\d{10,20}\.\d{6}$/.test(value);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function address(value: DeliveryAddress): DeliveryAddress {
  if (
    (!channel(value.chatId) && !slackRecipient(value.chatId)) ||
    (slackRecipient(value.chatId) && value.threadId !== undefined) ||
    (value.threadId !== undefined && !timestamp(value.threadId))
  )
    throw new Error("Invalid Slack delivery destination");
  return { ...value };
}
function blocks(summary: string) {
  if (!summary || summary.length > 10000)
    throw new Error("Invalid routine output");
  const chunks: string[] = [];
  let chunk = "";
  for (const character of summary) {
    if (chunk.length + character.length > 2800) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((text) => ({
    type: "section",
    text: { type: "plain_text", text, emoji: false },
  }));
}
function metadata(d: RoutineExternalDelivery) {
  return {
    event_type: "mindi_routine_output",
    event_payload: {
      request_key: d.requestKey,
      output_sha256: createHash("sha256").update(d.summary).digest("hex"),
    },
  };
}
const rejectedErrors = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_blocks",
  "invalid_blocks_format",
  "invalid_arguments",
  "no_permission",
  "restricted_action",
  "ratelimited",
  "rate_limited",
]);
/** Fixed-origin Slack transport. The injected fetch is a test seam, never config. */
export function createSlackDeliveryAdapter(
  input: SlackDeliveryConfig,
  token: string,
  request: typeof fetch = fetch,
): RoutineDeliveryAdapter {
  const config = structuredClone(input);
  const home = config.home ? address(config.home) : undefined;
  const aliases = Object.fromEntries(
    Object.entries(config.aliases ?? {}).map(([name, target]) => [
      name,
      address(target),
    ]),
  );
  if (
    !token ||
    token.length > 16384 ||
    Array.from(token).some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126)
  )
    throw new Error("Invalid Slack credential");
  function http(uploads?: DeliveryUploadReader) {
    return createSlackHttp({
      token,
      request,
      guard: () => uploads?.assertWorkspaceAvailable(config.teamId),
      rateLimit: (ms) => uploads?.pauseWorkspace(config.teamId, ms),
    });
  }
  async function api(
    method: SlackMethod,
    args: Record<string, unknown>,
    signal: AbortSignal,
    uploads?: DeliveryUploadReader,
  ) {
    try {
      return await http(uploads).api(method, args, signal);
    } catch (error) {
      if (error instanceof SlackRateLimitError) throw error;
      throw unknown();
    }
  }
  async function identity(signal: AbortSignal, uploads?: DeliveryUploadReader) {
    try {
      const value = await api("auth.test", {}, signal, uploads);
      if (
        value.ok !== true ||
        value.team_id !== config.teamId ||
        value.user_id !== config.userId
      )
        return;
      return {
        userId: config.userId,
        botId: typeof value.bot_id === "string" ? value.bot_id : undefined,
      };
    } catch {
      signal.throwIfAborted();
      return;
    }
  }
  function validTarget(d: RoutineExternalDelivery) {
    return (
      d.target.bindingId === config.id &&
      d.target.bindingRevision === config.revision &&
      d.target.platform === "slack" &&
      config.profileIds.includes(d.profileId) &&
      (channel(d.target.chatId) || slackRecipient(d.target.chatId)) &&
      (!slackRecipient(d.target.chatId) || d.target.threadId === undefined) &&
      (d.target.threadId === undefined || timestamp(d.target.threadId))
    );
  }
  function match(
    raw: unknown,
    d: RoutineExternalDelivery,
    actor: { userId: string; botId?: string },
  ): string | undefined {
    const message = record(raw);
    if (!message || !timestamp(message.ts)) return;
    if (
      (message.user !== undefined && message.user !== actor.userId) ||
      (message.bot_id !== undefined && message.bot_id !== actor.botId) ||
      (message.user !== actor.userId &&
        (!actor.botId || message.bot_id !== actor.botId))
    )
      return;
    if (
      d.target.threadId
        ? message.thread_ts !== d.target.threadId
        : message.thread_ts !== undefined && message.thread_ts !== message.ts
    )
      return;
    const meta = record(message.metadata),
      payload = record(meta?.event_payload),
      expected = metadata(d);
    if (
      meta?.event_type !== expected.event_type ||
      payload?.request_key !== d.requestKey ||
      payload?.output_sha256 !== expected.event_payload.output_sha256
    )
      return;
    if (
      !Array.isArray(message.blocks) ||
      message.blocks.length < 1 ||
      message.blocks.length > 50
    )
      return;
    const contents: string[] = [];
    for (const rawBlock of message.blocks) {
      const block = record(rawBlock),
        text = record(block?.text);
      if (
        block?.type !== "section" ||
        text?.type !== "plain_text" ||
        typeof text.text !== "string" ||
        block.fields !== undefined ||
        block.accessory !== undefined
      )
        return;
      contents.push(text.text);
    }
    if (contents.join("") !== d.summary) return;
    return `slack:${d.target.chatId}:${message.ts}`;
  }
  const adapter: RoutineDeliveryAdapter = {
    id: config.id,
    revision: config.revision,
    platform: "slack",
    profileIds: [...config.profileIds],
    ...(home ? { home } : {}),
    resolve: (destination, origin) => {
      if (Object.hasOwn(aliases, destination))
        return { ...aliases[destination]! };
      const parts = destination.split(":");
      if (parts.length > 2 || (parts.length === 2 && !parts[1]))
        throw new Error("Invalid Slack delivery destination");
      const chatId = parts[0]!;
      const threadId =
        parts[1] ?? (origin?.chatId === chatId ? origin.threadId : undefined);
      return address({ chatId, ...(threadId ? { threadId } : {}) });
    },
    normalizeOrigin: (origin, currentHome) =>
      address(
        origin.threadId !== undefined &&
          origin.chatId === currentHome?.chatId &&
          origin.threadId !== currentHome.threadId
          ? {
              chatId: origin.chatId,
              ...(currentHome.threadId
                ? { threadId: currentHome.threadId }
                : {}),
            }
          : origin,
      ),
    send: async (d, signal, _operations, _outputs, uploads) => {
      signal.throwIfAborted();
      if (!validTarget(d)) return { state: "rejected" };
      const content = blocks(d.summary),
        actor = await identity(signal, uploads);
      if (!actor) return { state: "rejected" };
      const result = await api(
        "chat.postMessage",
        {
          channel: d.target.chatId,
          blocks: content,
          metadata: metadata(d),
          unfurl_links: false,
          unfurl_media: false,
          ...(d.target.threadId ? { thread_ts: d.target.threadId } : {}),
        },
        signal,
        uploads,
      );
      if (
        result.ok === false &&
        typeof result.error === "string" &&
        rejectedErrors.has(result.error)
      )
        return { state: "rejected" };
      const warnings = record(result.response_metadata)?.warnings;
      if (
        result.ok !== true ||
        result.channel !== d.target.chatId ||
        !timestamp(result.ts) ||
        (Array.isArray(warnings) && warnings.includes("message_truncated"))
      )
        throw unknown();
      const receipt = match(result.message, d, actor);
      if (!receipt || record(result.message)?.ts !== result.ts) throw unknown();
      return { state: "delivered", receipt };
    },
    reconcile: async (d, signal, _operations, uploads) => {
      signal.throwIfAborted();
      if (!validTarget(d)) return { state: "unknown" };
      const actor = await identity(signal, uploads);
      if (!actor) return { state: "unknown" };
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const result = await api(
          d.target.threadId ? "conversations.replies" : "conversations.history",
          {
            channel: d.target.chatId,
            limit: 100,
            include_all_metadata: true,
            oldest: Math.max(0, Date.parse(d.createdAt) / 1000 - 60),
            inclusive: true,
            ...(d.target.threadId ? { ts: d.target.threadId } : {}),
            ...(cursor ? { cursor } : {}),
          },
          signal,
          uploads,
        );
        if (
          result.ok !== true ||
          !Array.isArray(result.messages) ||
          result.messages.length > 100
        )
          return { state: "unknown" };
        for (const message of result.messages) {
          const receipt = match(message, d, actor);
          if (receipt) return { state: "delivered", receipt };
        }
        const next = record(result.response_metadata)?.next_cursor;
        if (
          typeof next !== "string" ||
          !next ||
          next.length > 2048 ||
          seen.has(next)
        )
          return { state: "unknown" };
        seen.add(next);
        cursor = next;
      }
      return { state: "unknown" };
    },
  };
  const sendText = adapter.send,
    findText = adapter.reconcile!;
  return {
    ...adapter,
    supportsOutputs: true,
    send: async (d, signal, operations, outputs, uploads) => {
      if (d.outputs !== undefined || slackRecipient(d.target.chatId)) {
        if (
          !validTarget(d) ||
          !operations ||
          (!outputs && d.outputs !== undefined) ||
          !uploads
        )
          return { state: "rejected" };
        return sendSlackFiles({
          config,
          delivery: d,
          signal,
          operations,
          outputs: outputs ?? {
            read: async () => {
              throw unknown();
            },
          },
          uploads,
          http: http(uploads),
          verify: async () => !!(await identity(signal, uploads)),
          sendText: (physicalChannel) =>
            sendText(
              { ...d, target: { ...d.target, chatId: physicalChannel } },
              signal,
              undefined,
              undefined,
              uploads,
            ),
        });
      }
      try {
        return await sendText(d, signal, operations, outputs, uploads);
      } catch (error) {
        if (error instanceof SlackRateLimitError) return { state: "rejected" };
        throw error;
      }
    },
    reconcile: async (d, signal, operations, uploads) => {
      if (d.outputs !== undefined || slackRecipient(d.target.chatId)) {
        if (!validTarget(d) || !operations || !uploads)
          return { state: "unknown" };
        return reconcileSlackFiles({
          config,
          delivery: d,
          signal,
          operations,
          uploads,
          http: http(uploads),
          verify: async () => !!(await identity(signal, uploads)),
          findText: (physicalChannel) =>
            findText(
              { ...d, target: { ...d.target, chatId: physicalChannel } },
              signal,
              undefined,
              uploads,
            ),
        });
      }
      return findText(d, signal, operations, uploads);
    },
  };
}
