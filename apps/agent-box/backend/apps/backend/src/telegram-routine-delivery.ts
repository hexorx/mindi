import {
  taskOutputManifest,
  type TaskOutputMetadata,
} from "@mindi/agent-runtime/task-outputs";
import type { DeliveryOperationSpec } from "@mindi/routines";
import type {
  DeliveryAddress,
  RoutineDeliveryAdapter,
  RoutineExternalDelivery,
} from "@mindi/routines";
export interface TelegramDeliveryConfig {
  id: string;
  revision: number;
  platform: "telegram";
  profileIds: string[];
  userId: string;
  tokenFile: string;
  home?: DeliveryAddress;
  aliases?: Record<string, DeliveryAddress>;
}
export const telegramId = (value: unknown, positive = false): value is string =>
  typeof value === "string" &&
  (positive ? /^[1-9]\d{0,15}$/ : /^-?[1-9]\d{0,15}$/).test(value) &&
  BigInt(value) <= 4503599627370495n &&
  BigInt(value) >= -4503599627370495n;
export const telegramTopicId = (value: unknown): value is string =>
  telegramId(value, true) && BigInt(value) <= 2147483647n;
const unknown = () => Error("Telegram delivery outcome is unknown");
class Rejected extends Error {}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unknown();
  return value as Record<string, unknown>;
}
function address(value: DeliveryAddress) {
  if (
    !telegramId(value.chatId) ||
    (value.threadId !== undefined && !telegramTopicId(value.threadId))
  )
    throw Error("Invalid Telegram destination");
  return { ...value };
}
function plan(delivery: RoutineExternalDelivery): DeliveryOperationSpec[] {
  if (
    typeof delivery.summary !== "string" ||
    delivery.summary.length > 10000 ||
    (!delivery.summary && delivery.outputs === undefined)
  )
    throw unknown();
  const outputs =
    delivery.outputs === undefined
      ? []
      : taskOutputManifest(delivery.outputs, delivery.outputs[0]!.scope);
  if (outputs.some((file) => file.scope.profileId !== delivery.profileId))
    throw unknown();
  const chunks: string[] = [];
  let chunk = "";
  for (const character of delivery.summary) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw unknown();
    if (chunk.length + character.length > 4096) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return [
    ...chunks.map((payload, index) => ({
      key: `telegram-v1-${index}`,
      kind: "message" as const,
      payload,
    })),
    ...outputs.map((output, index) => ({
      key: `telegram-file-v1-${index}`,
      kind: "attachment" as const,
      payload: JSON.stringify(output),
    })),
  ];
}
/** Fixed Bot API origin. Tokens and provider error descriptions never enter errors. */
export function createTelegramDeliveryAdapter(
  input: TelegramDeliveryConfig,
  token: string,
  request: typeof fetch = fetch,
): RoutineDeliveryAdapter {
  const config = structuredClone(input);
  if (
    !telegramId(config.userId, true) ||
    !/^\d+:[A-Za-z0-9_-]+$/.test(token) ||
    token.length > 16384
  )
    throw Error("Invalid Telegram credential or identity");
  const home = config.home ? address(config.home) : undefined;
  const aliases = Object.fromEntries(
    Object.entries(config.aliases ?? {}).map(([key, value]) => [
      key,
      address(value),
    ]),
  );
  function localScope(delivery: RoutineExternalDelivery) {
    if (
      delivery.target.bindingId !== config.id ||
      delivery.target.bindingRevision !== config.revision ||
      delivery.target.platform !== "telegram" ||
      !config.profileIds.includes(delivery.profileId)
    )
      throw unknown();
    return address(delivery.target);
  }
  async function api(
    method: string,
    signal: AbortSignal,
    body: Record<string, unknown> | FormData = {},
  ) {
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await request(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          ...(body instanceof FormData
            ? { body }
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
          redirect: "error",
          signal,
        },
      );
    } catch {
      throw unknown();
    }
    const reader = response.body?.getReader();
    if (!reader) throw unknown();
    let size = 0;
    const buffers: Uint8Array[] = [];
    let value: Record<string, unknown>;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024 * 1024) throw unknown();
        buffers.push(part.value);
      }
      value = record(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(buffers),
          ),
        ),
      );
    } catch {
      await reader.cancel().catch(() => {});
      throw unknown();
    } finally {
      reader.releaseLock();
    }
    if (
      value.ok === false &&
      [400, 401, 403, 404, 429].includes(response.status) &&
      value.error_code === response.status
    )
      throw new Rejected("Telegram rejected request");
    if (!response.ok || value.ok !== true) throw unknown();
    return record(value.result);
  }
  function savedReceipt(value: string | undefined, target: DeliveryAddress) {
    const parts = value?.split(":");
    if (
      parts?.length !== 5 ||
      parts[0] !== "telegram" ||
      parts[1] !== config.userId ||
      parts[2] !== target.chatId ||
      parts[3] !== (target.threadId ?? "0") ||
      !telegramTopicId(parts[4])
    )
      throw unknown();
    return value!;
  }
  function matched(
    message: Record<string, unknown>,
    target: DeliveryAddress,
    type: unknown,
    text: string | undefined,
    file?: TaskOutputMetadata,
  ) {
    const chat = record(message.chat);
    if (
      !Number.isInteger(message.message_id) ||
      Number(message.message_id) <= 0 ||
      Number(message.message_id) > 2147483647 ||
      !Number.isSafeInteger(message.date) ||
      Number(message.date) <= 0 ||
      chat.id !== Number(target.chatId) ||
      chat.type !== type ||
      message.text !== text ||
      message.message_thread_id !==
        (target.threadId ? Number(target.threadId) : undefined) ||
      [
        "business_connection_id",
        "direct_messages_topic",
        "ephemeral_message_id",
        "receiver_user",
        "guest_query_id",
        "is_paid_post",
        "is_automatic_forward",
        "forward_origin",
        "sender_business_bot",
        "is_ephemeral",
        "ephemeral_message_parameters",
        "guest_bot_caller_user",
        "guest_bot_caller_chat",
      ].some((k) => message[k] !== undefined)
    )
      throw unknown();
    if (type !== "channel" || message.from !== undefined) {
      const from = record(message.from);
      if (from.id !== Number(config.userId) || from.is_bot !== true)
        throw unknown();
    }
    if (message.sender_chat !== undefined) {
      const sender = record(message.sender_chat);
      if (
        type !== "channel" ||
        sender.id !== Number(target.chatId) ||
        sender.type !== "channel"
      )
        throw unknown();
    }
    if (file) {
      const document = record(message.document);
      if (
        message.caption !== undefined ||
        document.file_name !== file.name ||
        document.file_size !== file.size ||
        document.mime_type !== file.mediaType ||
        typeof document.file_id !== "string" ||
        !document.file_id ||
        document.file_id.length > 1024 ||
        typeof document.file_unique_id !== "string" ||
        !document.file_unique_id ||
        document.file_unique_id.length > 1024
      )
        throw unknown();
    } else if (message.document !== undefined) throw unknown();
    return `telegram:${config.userId}:${target.chatId}:${target.threadId ?? "0"}:${message.message_id}`;
  }
  return {
    id: config.id,
    revision: config.revision,
    platform: "telegram",
    supportsOutputs: true,
    profileIds: [...config.profileIds],
    ...(home ? { home } : {}),
    resolve: (destination, origin) => {
      if (Object.hasOwn(aliases, destination))
        return { ...aliases[destination]! };
      const parts = destination.split(":");
      if (parts.length > 2 || (parts.length === 2 && !parts[1]))
        throw Error("Invalid Telegram destination");
      const chatId = parts[0]!;
      const threadId =
        parts[1] ?? (origin?.chatId === chatId ? origin.threadId : undefined);
      return address({ chatId, ...(threadId ? { threadId } : {}) });
    },
    normalizeOrigin: (origin) => address(origin),
    send: async (delivery, signal, operations, outputs) => {
      if (!operations) throw unknown();
      let target: DeliveryAddress;
      let chat: Record<string, unknown>;
      try {
        target = localScope(delivery);
        const user = await api("getMe", signal);
        if (user.id !== Number(config.userId) || user.is_bot !== true)
          throw unknown();
        chat = await api("getChat", signal, { chat_id: target.chatId });
        if (
          chat.id !== Number(target.chatId) ||
          typeof chat.type !== "string" ||
          !["private", "group", "supergroup", "channel"].includes(
            String(chat.type),
          ) ||
          chat.is_direct_messages === true
        )
          throw unknown();
        if (
          target.threadId &&
          !(
            (chat.type === "supergroup" && chat.is_forum === true) ||
            (chat.type === "private" && user.has_topics_enabled === true)
          )
        )
          throw unknown();
      } catch {
        signal.throwIfAborted();
        return { state: "rejected" };
      }
      const parts = operations.prepare(plan(delivery));
      const files = new Map<
        number,
        { metadata: TaskOutputMetadata; bytes: Uint8Array }
      >();
      try {
        for (const [index, part] of parts.entries()) {
          if (part.kind === "attachment" && part.state !== "confirmed") {
            if (!outputs) throw unknown();
            const metadata = JSON.parse(part.payload) as TaskOutputMetadata;
            const content = await outputs.read(metadata.id);
            if (JSON.stringify(content.metadata) !== part.payload)
              throw unknown();
            files.set(index, content);
          }
        }
      } catch {
        signal.throwIfAborted();
        return { state: "rejected" };
      }
      for (const [index, part] of parts.entries()) {
        if (part.state === "confirmed") {
          savedReceipt(part.receipt, target);
          continue;
        }
        operations.claim(index);
        let message: Record<string, unknown>;
        try {
          const file = files.get(index);
          if (file) {
            const body = new FormData();
            body.set("chat_id", target.chatId);
            if (target.threadId) body.set("message_thread_id", target.threadId);
            body.set("disable_content_type_detection", "true");
            body.set(
              "document",
              new Blob([Uint8Array.from(file.bytes)], {
                type: file.metadata.mediaType,
              }),
              file.metadata.name,
            );
            message = await api("sendDocument", signal, body);
          } else
            message = await api("sendMessage", signal, {
              chat_id: target.chatId,
              ...(target.threadId
                ? { message_thread_id: Number(target.threadId) }
                : {}),
              text: part.payload,
              entities: [],
              link_preview_options: { is_disabled: true },
            });
        } catch (error) {
          if (error instanceof Rejected) {
            operations.reject(index);
            return { state: "rejected" };
          }
          throw unknown();
        }
        operations.confirm(
          index,
          matched(
            message,
            target,
            chat.type,
            part.kind === "attachment" ? undefined : part.payload,
            files.get(index)?.metadata,
          ),
        );
      }
      return {
        state: "delivered",
        receipt: operations.list().at(-1)!.receipt!,
      };
    },
    reconcile: async (delivery, signal, operations) => {
      try {
        signal.throwIfAborted();
        if (!operations) return { state: "unknown" };
        const target = localScope(delivery),
          expected = plan(delivery),
          parts = operations.list();
        if (
          parts.length !== expected.length ||
          parts.some(
            (part, i) =>
              part.key !== expected[i]!.key ||
              part.kind !== expected[i]!.kind ||
              part.payload !== expected[i]!.payload ||
              part.state !== "confirmed",
          )
        )
          return { state: "unknown" };
        for (const part of parts) savedReceipt(part.receipt, target);
        return { state: "delivered", receipt: parts.at(-1)!.receipt! };
      } catch {
        return { state: "unknown" };
      }
    },
  };
}
