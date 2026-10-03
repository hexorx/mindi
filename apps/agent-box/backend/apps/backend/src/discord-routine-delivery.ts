import {
  taskOutputManifest,
  type TaskOutputMetadata,
} from "@mindi/agent-runtime/task-outputs";
import { createHash } from "node:crypto";
import type {
  DeliveryAddress,
  RoutineDeliveryAdapter,
  RoutineExternalDelivery,
} from "@mindi/routines";
export interface DiscordDeliveryConfig {
  id: string;
  revision: number;
  platform: "discord";
  profileIds: string[];
  guildId?: string;
  userId: string;
  tokenFile: string;
  home?: DeliveryAddress;
  aliases?: Record<string, DeliveryAddress>;
  forumTags?: Record<string, string[]>;
  dmRecipients?: Record<string, string>;
}
const unknown = () => Error("Discord delivery outcome is unknown");
class Rejected extends Error {}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unknown();
  return value as Record<string, unknown>;
};
export const discordId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,19}$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
export function discordForumTags(value: unknown): Record<string, string[]> {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length > 128
  )
    throw Error("Invalid Discord forum tags");
  return Object.fromEntries(
    Object.entries(value)
      .map(([channelId, tags]) => {
        if (
          !discordId(channelId) ||
          !Array.isArray(tags) ||
          tags.length < 1 ||
          tags.length > 5 ||
          Array.from(tags).some((tag) => !discordId(tag)) ||
          new Set(tags).size !== tags.length
        )
          throw Error("Invalid Discord forum tags");
        return [channelId, [...tags].sort()];
      })
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}
export function discordDmRecipients(value: unknown): Record<string, string> {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length > 128
  )
    throw Error("Invalid Discord DM recipients");
  return Object.fromEntries(
    Object.entries(value)
      .map(([channel, recipient]) => {
        if (!discordId(channel) || !discordId(recipient))
          throw Error("Invalid Discord DM recipients");
        return [channel, recipient];
      })
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}
function tagMatch(row: Record<string, unknown>, tags?: string[]) {
  if (!tags) return true;
  return (
    Array.isArray(row.applied_tags) &&
    row.applied_tags.every(discordId) &&
    new Set(row.applied_tags).size === row.applied_tags.length &&
    JSON.stringify([...row.applied_tags].sort()) === JSON.stringify(tags)
  );
}
function address(value: DeliveryAddress) {
  if (
    !discordId(value.chatId) ||
    (value.threadId !== undefined && !discordId(value.threadId))
  )
    throw Error("Invalid Discord destination");
  return { ...value };
}
function receipt(channelId: string, messageId: string) {
  return `discord:${channelId}:${messageId}`;
}
function readReceipt(value: string | undefined) {
  const parts = value?.split(":");
  if (
    parts?.length !== 3 ||
    parts[0] !== "discord" ||
    !discordId(parts[1]) ||
    !discordId(parts[2])
  )
    throw unknown();
  return { channelId: parts[1], messageId: parts[2] };
}
type Part = {
  key: string;
  kind: "message" | "thread" | "attachment";
  payload: string;
};
type Payload = {
  content: string;
  marker: string;
  name: string;
  file?: TaskOutputMetadata;
  appliedTags?: string[];
};
function plan(
  delivery: RoutineExternalDelivery,
  forum: boolean,
  appliedTags?: string[],
): Part[] {
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
    if (chunk.length + character.length > 2000) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  const entries: { content: string; file?: TaskOutputMetadata }[] = [
    ...chunks.map((content) => ({ content })),
    ...outputs.map((file) => ({ content: "", file })),
  ];
  return entries.map(({ content, file }, index) => {
    const kind =
      forum && index === 0 ? "thread" : file ? "attachment" : "message";
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          version: appliedTags ? 3 : outputs.length ? 2 : 1,
          ...(appliedTags ? { appliedTags } : {}),
          requestKey: delivery.requestKey,
          target: delivery.target,
          summary: delivery.summary,
          kind,
          content,
          index,
          count: entries.length,
          ...(outputs.length ? { outputs } : {}),
          ...(file ? { file } : {}),
        }),
      )
      .digest("hex");
    let title = "";
    for (const c of delivery.summary.split("\n")[0]!) {
      if (title.length + c.length > 70) break;
      title += c.charCodeAt(0) < 32 ? " " : c;
    }
    return {
      key: appliedTags
        ? `discord-tags-v1-${index}`
        : outputs.length
          ? `discord-files-v1-${index}`
          : `discord-v1-${index}`,
      kind,
      payload: JSON.stringify({
        content,
        ...(appliedTags ? { appliedTags } : {}),
        ...(file ? { file } : {}),
        marker: `Routine receipt ${digest}`,
        name: `${title.trim() || "Routine output"} · ${digest.slice(0, 12)}`,
      }),
    };
  });
}
/** Fixed-origin, guild-scoped transport. Fetch injection is only a fixture seam. */
export function createDiscordDeliveryAdapter(
  input: DiscordDeliveryConfig,
  token: string,
  request: typeof fetch = fetch,
): RoutineDeliveryAdapter {
  const config = structuredClone(input);
  if (config.dmRecipients !== undefined)
    config.dmRecipients = discordDmRecipients(config.dmRecipients);
  if (config.forumTags !== undefined)
    config.forumTags = discordForumTags(config.forumTags);
  if (
    (config.guildId === undefined
      ? !Object.keys(config.dmRecipients ?? {}).length
      : !discordId(config.guildId)) ||
    !discordId(config.userId) ||
    !token ||
    token.length > 16384 ||
    /[^\x21-\x7e]/.test(token)
  )
    throw Error("Invalid Discord credential or identity");
  const home = config.home ? address(config.home) : undefined;
  const aliases = Object.fromEntries(
    Object.entries(config.aliases ?? {}).map(([key, value]) => [
      key,
      address(value),
    ]),
  );
  async function api(
    path: string,
    signal: AbortSignal,
    body?: Record<string, unknown> | FormData,
  ): Promise<unknown> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await request(new URL("https://discord.com/api/v10" + path), {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bot ${token}`,
          ...(body instanceof FormData
            ? {}
            : { "content-type": "application/json" }),
        },
        redirect: "error",
        signal,
        ...(body
          ? { body: body instanceof FormData ? body : JSON.stringify(body) }
          : {}),
      });
    } catch {
      throw unknown();
    }
    const reader = response.body?.getReader();
    if (!reader) throw unknown();
    const buffers: Uint8Array[] = [];
    let size = 0;
    let value: unknown;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024 * 1024) throw unknown();
        buffers.push(part.value);
      }
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(buffers),
        ),
      );
    } catch {
      await reader.cancel().catch(() => {});
      throw unknown();
    } finally {
      reader.releaseLock();
    }
    if (!response.ok) {
      const error = record(value);
      if (
        [400, 401, 403, 404, 413, 429].includes(response.status) &&
        typeof error.message === "string" &&
        (Number.isSafeInteger(error.code) ||
          (response.status === 429 &&
            typeof error.retry_after === "number" &&
            Number.isFinite(error.retry_after) &&
            error.retry_after >= 0))
      )
        throw new Rejected("Discord rejected request");
      throw unknown();
    }
    return value;
  }
  async function channel(id: string, signal: AbortSignal) {
    const value = record(await api(`/channels/${id}`, signal));
    const recipient = config.dmRecipients?.[id];
    if (value.id !== id) throw unknown();
    if (recipient !== undefined) {
      if (
        value.type !== 1 ||
        value.guild_id !== undefined ||
        !Array.isArray(value.recipients) ||
        value.recipients.length !== 1 ||
        record(value.recipients[0]).id !== recipient
      )
        throw unknown();
    } else if (!config.guildId || value.guild_id !== config.guildId)
      throw unknown();
    return value;
  }
  const threadScope = (value: Record<string, unknown>, parentId: string) =>
    value.guild_id === config.guildId &&
    value.parent_id === parentId &&
    [10, 11, 12].includes(Number(value.type)) &&
    typeof value.type === "number";
  async function scope(delivery: RoutineExternalDelivery, signal: AbortSignal) {
    if (
      delivery.target.bindingId !== config.id ||
      delivery.target.bindingRevision !== config.revision ||
      delivery.target.platform !== "discord" ||
      !config.profileIds.includes(delivery.profileId)
    )
      throw unknown();
    address(delivery.target);
    const user = record(await api("/users/@me", signal));
    if (user.id !== config.userId || user.bot !== true) throw unknown();
    const parent = await channel(delivery.target.chatId, signal);
    if (config.dmRecipients?.[delivery.target.chatId] !== undefined) {
      if (delivery.target.threadId !== undefined) throw unknown();
      return { forum: false, channelId: delivery.target.chatId };
    }
    if (delivery.target.threadId) {
      if (
        ![0, 5, 15, 16].includes(Number(parent.type)) ||
        typeof parent.type !== "number"
      )
        throw unknown();
      const thread = await channel(delivery.target.threadId, signal);
      if (!threadScope(thread, delivery.target.chatId)) throw unknown();
      return { forum: false, channelId: delivery.target.threadId };
    }
    if (parent.type === 15 || parent.type === 16) {
      const appliedTags = config.forumTags?.[delivery.target.chatId];
      const availableTags = parent.available_tags;
      if (
        appliedTags &&
        (!Array.isArray(availableTags) ||
          appliedTags.some(
            (id) =>
              !availableTags.some((tag: unknown) => record(tag).id === id),
          ))
      )
        throw unknown();
      return {
        appliedTags,
        forum: true,
        channelId: delivery.target.chatId,
        requiresTags: typeof parent.flags === "number" && !!(parent.flags & 16),
      };
    }
    if (
      [10, 11, 12].includes(Number(parent.type)) &&
      typeof parent.type === "number"
    ) {
      if (!discordId(parent.parent_id)) throw unknown();
      const owner = await channel(parent.parent_id, signal);
      if (![0, 5, 15, 16].includes(Number(owner.type))) throw unknown();
    } else if (parent.type !== 0 && parent.type !== 5) throw unknown();
    return { forum: false, channelId: delivery.target.chatId };
  }
  function matched(
    value: unknown,
    channelId: string,
    payload: Payload,
  ): string | undefined {
    const message = record(value),
      author = record(message.author);
    if (
      !discordId(message.id) ||
      message.channel_id !== channelId ||
      author.id !== config.userId ||
      author.bot !== true ||
      message.webhook_id !== undefined ||
      message.content !== payload.content ||
      !Array.isArray(message.attachments) ||
      message.attachments.length !== (payload.file ? 1 : 0) ||
      !Array.isArray(message.embeds)
    )
      return;
    if (payload.file) {
      const attachment = record(message.attachments[0]);
      if (
        !discordId(attachment.id) ||
        attachment.filename !== payload.file.name ||
        attachment.size !== payload.file.size ||
        attachment.ephemeral === true
      )
        return;
    }
    const markers = message.embeds.filter((embed) => {
      const footer = record(embed).footer;
      return footer !== undefined && record(footer).text === payload.marker;
    });
    if (markers.length !== 1) return;
    return receipt(channelId, message.id);
  }
  async function findMessages(
    channelId: string,
    payload: Payload,
    signal: AbortSignal,
  ): Promise<string[]> {
    const found = new Set<string>(),
      seen = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const values = await api(
        `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`,
        signal,
      );
      if (!Array.isArray(values) || values.length > 100) throw unknown();
      let last = before;
      for (const value of values) {
        const row = record(value);
        if (
          !discordId(row.id) ||
          row.channel_id !== channelId ||
          seen.has(row.id) ||
          (last && BigInt(row.id) >= BigInt(last))
        )
          throw unknown();
        seen.add(row.id);
        last = row.id;
        const match = matched(row, channelId, payload);
        if (match) found.add(match);
      }
      if (values.length < 100) return [...found];
      before = last;
    }
    throw unknown();
  }
  async function findForum(
    parentId: string,
    payload: Payload,
    signal: AbortSignal,
  ): Promise<string[]> {
    const candidates = new Map<string, Record<string, unknown>>();
    const add = (value: unknown) => {
      if (!Array.isArray(value) || value.length > 1000) throw unknown();
      for (const item of value) {
        const row = record(item);
        if (!discordId(row.id)) throw unknown();
        if (
          threadScope(row, parentId) &&
          row.type === 11 &&
          row.owner_id === config.userId &&
          row.name === payload.name &&
          tagMatch(row, payload.appliedTags)
        )
          candidates.set(row.id, row);
      }
    };
    add(
      record(await api(`/guilds/${config.guildId}/threads/active`, signal))
        .threads,
    );
    let before: string | undefined,
      complete = false;
    for (let page = 0; page < 10; page++) {
      const value = record(
        await api(
          `/channels/${parentId}/threads/archived/public?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`,
          signal,
        ),
      );
      add(value.threads);
      if (value.has_more === false) {
        complete = true;
        break;
      }
      if (
        value.has_more !== true ||
        !Array.isArray(value.threads) ||
        !value.threads.length
      )
        throw unknown();
      const last = record(
        record(value.threads.at(-1)).thread_metadata,
      ).archive_timestamp;
      if (
        typeof last !== "string" ||
        !Number.isFinite(Date.parse(last)) ||
        (before && Date.parse(last) >= Date.parse(before))
      )
        throw unknown();
      before = last;
    }
    if (!complete || candidates.size > 100) throw unknown();
    const found = new Set<string>();
    for (const id of candidates.keys()) {
      const current = await channel(id, signal);
      if (
        !threadScope(current, parentId) ||
        current.type !== 11 ||
        current.owner_id !== config.userId ||
        !tagMatch(current, payload.appliedTags)
      )
        throw unknown();
      const starter = record(
        await api(`/channels/${id}/messages/${id}`, signal),
      );
      if (starter.id !== id) throw unknown();
      const match = matched(starter, id, payload);
      if (match) found.add(match);
    }
    return [...found];
  }
  return {
    id: config.id,
    revision: config.revision,
    platform: "discord",
    supportsOutputs: true,
    profileIds: [...config.profileIds],
    ...(home ? { home } : {}),
    resolve: (destination, origin) => {
      if (Object.hasOwn(aliases, destination))
        return { ...aliases[destination]! };
      const parts = destination.split(":");
      if (parts.length > 2 || (parts.length === 2 && !parts[1]))
        throw Error("Invalid Discord destination");
      const chatId = parts[0]!;
      const threadId =
        parts[1] ?? (origin?.chatId === chatId ? origin.threadId : undefined);
      return address({ chatId, ...(threadId ? { threadId } : {}) });
    },
    normalizeOrigin: (origin) => address(origin),
    send: async (delivery, signal, operations, outputs) => {
      if (!operations) throw unknown();
      let target: Awaited<ReturnType<typeof scope>>;
      try {
        target = await scope(delivery, signal);
        if (target.requiresTags && !target.appliedTags)
          return { state: "rejected" };
      } catch {
        signal.throwIfAborted();
        return { state: "rejected" };
      }
      const parts = operations.prepare(
        plan(delivery, target.forum, target.appliedTags),
      );
      const files = new Map<number, Uint8Array>();
      try {
        for (const [index, part] of parts.entries()) {
          const payload = JSON.parse(part.payload) as Payload;
          if (payload.file && part.state !== "confirmed") {
            if (!outputs) throw unknown();
            const content = await outputs.read(payload.file.id);
            if (
              JSON.stringify(content.metadata) !== JSON.stringify(payload.file)
            )
              throw unknown();
            files.set(index, content.bytes);
          }
        }
      } catch {
        signal.throwIfAborted();
        return { state: "rejected" };
      }
      let channelId = target.channelId;
      for (const [index, part] of parts.entries()) {
        if (part.state === "confirmed") {
          const saved = readReceipt(part.receipt);
          if (part.kind === "thread") channelId = saved.channelId;
          else if (saved.channelId !== channelId) throw unknown();
          continue;
        }
        const payload = JSON.parse(part.payload) as Payload;
        if (target.forum && index > 0) {
          const thread = await channel(channelId, signal);
          if (
            !threadScope(thread, target.channelId) ||
            thread.type !== 11 ||
            thread.owner_id !== config.userId ||
            !tagMatch(thread, payload.appliedTags)
          )
            throw unknown();
        }
        operations.claim(index);
        const message = {
          content: payload.content,
          ...(payload.file
            ? { attachments: [{ id: 0, filename: payload.file.name }] }
            : {}),
          embeds: [{ footer: { text: payload.marker } }],
          allowed_mentions: {
            parse: [],
            users: [],
            roles: [],
            replied_user: false,
          },
        };
        let value: unknown;
        try {
          let body: Record<string, unknown> | FormData =
            part.kind === "thread"
              ? {
                  name: payload.name,
                  message,
                  ...(payload.appliedTags
                    ? { applied_tags: payload.appliedTags }
                    : {}),
                }
              : message;
          if (payload.file) {
            const form = new FormData();
            form.set("payload_json", JSON.stringify(body));
            form.set(
              "files[0]",
              new Blob([Uint8Array.from(files.get(index)!)], {
                type: payload.file.mediaType,
              }),
              payload.file.name,
            );
            body = form;
          }
          value = await api(
            part.kind === "thread"
              ? `/channels/${channelId}/threads`
              : `/channels/${channelId}/messages`,
            signal,
            body,
          );
        } catch (error) {
          if (error instanceof Rejected) {
            operations.reject(index);
            return { state: "rejected" };
          }
          throw unknown();
        }
        if (part.kind === "thread") {
          const created = record(value);
          if (
            !discordId(created.id) ||
            !threadScope(created, channelId) ||
            created.type !== 11 ||
            created.owner_id !== config.userId ||
            !tagMatch(created, payload.appliedTags)
          )
            throw unknown();
          channelId = created.id;
          value = created.message;
          if (record(value).id !== channelId) throw unknown();
        }
        const confirmed = matched(value, channelId, payload);
        if (!confirmed) throw unknown();
        operations.confirm(index, confirmed);
      }
      return {
        state: "delivered",
        receipt: operations.list().at(-1)!.receipt!,
      };
    },
    reconcile: async (delivery, signal, operations) => {
      if (!operations) return { state: "unknown" };
      try {
        const target = await scope(delivery, signal),
          expected = plan(delivery, target.forum, target.appliedTags),
          parts = operations.list();
        if (
          !parts.length ||
          parts.length !== expected.length ||
          parts.some(
            (p, i) =>
              p.key !== expected[i]!.key ||
              p.kind !== expected[i]!.kind ||
              p.payload !== expected[i]!.payload,
          )
        )
          return { state: "unknown" };
        let channelId = target.channelId;
        for (const [index, part] of parts.entries()) {
          if (part.state === "confirmed") {
            const saved = readReceipt(part.receipt);
            if (part.kind === "thread") channelId = saved.channelId;
            else if (saved.channelId !== channelId) throw unknown();
            continue;
          }
          if (part.state !== "uncertain") break;
          const payload = JSON.parse(part.payload) as Payload;
          if (target.forum && index > 0) {
            const thread = await channel(channelId, signal);
            if (
              !threadScope(thread, target.channelId) ||
              thread.type !== 11 ||
              thread.owner_id !== config.userId ||
              !tagMatch(thread, payload.appliedTags)
            )
              throw unknown();
          }
          const found =
            part.kind === "thread"
              ? await findForum(channelId, payload, signal)
              : await findMessages(channelId, payload, signal);
          if (found.length !== 1) return { state: "unknown" };
          operations.confirm(index, found[0]!);
          if (part.kind === "thread")
            channelId = readReceipt(found[0]).channelId;
        }
        const final = operations.list();
        return final.every((p) => p.state === "confirmed")
          ? { state: "delivered", receipt: final.at(-1)!.receipt! }
          : { state: "unknown" };
      } catch {
        return { state: "unknown" };
      }
    },
  };
}
