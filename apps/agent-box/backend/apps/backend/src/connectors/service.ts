import { object } from "./validation.js";
import { telegramDisposition } from "./telegram-events.js";
import type { InboundFileAdmitter } from "./inbound-files.js";
import type { Message, MessagingStore } from "@mindi/messaging";
import { ConnectorAccountOwner } from "./account-owner.js";
import { ConnectorDispatcher } from "./dispatcher.js";
import {
  ConnectorReplyDispatcher,
  ConnectorReplyRejected,
  ConnectorReplyRateLimitUnknown,
} from "./replies.js";
import { createTelegramReplyTransport } from "./reply-telegram.js";
import { createDiscordReplyTransport } from "./reply-discord.js";
import { TelegramReceiver } from "./telegram.js";
import { TelegramRequestError, telegramApi } from "./telegram-api.js";
import { DiscordReceiver, type DiscordSocket } from "./discord.js";
import { discordGet, DiscordRetry } from "./discord-api.js";
import type { ConnectorConfig, ConnectorAccountConfig } from "./config.js";
import { ConnectorStore } from "./store.js";
import {
  ConnectorError,
  type ConnectorAccountIdentity,
  type ConnectorReplyRecord,
} from "./types.js";
import type { ConnectorReplyFileReader } from "./reply-transport-io.js";
const key = (
  account: Pick<ConnectorAccountIdentity, "provider" | "accountId">,
) => JSON.stringify([account.provider, account.accountId]);
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
export interface ConnectorHistoryGapRecovery {
  provider: "telegram" | "discord";
  accountId: string;
  expectedRevision: number;
  action: "skip-retained-updates" | "acknowledge-gap";
}
function identity(account: ConnectorAccountIdentity): ConnectorAccountIdentity {
  return {
    provider: account.provider,
    accountId: account.accountId,
    credentialGeneration: account.credentialGeneration,
  };
}
type ReadinessReason =
  | "webhook_conflict"
  | "identity_mismatch"
  | "intents_or_permissions"
  | "shard_requirement"
  | "provider_unavailable"
  | "history_gap"
  | "rate_limit_review";
function readinessReason(error: unknown): ReadinessReason {
  if (error instanceof ConnectorError) {
    if (error.message === "Telegram webhook must be resolved before polling")
      return "webhook_conflict";
    if (
      [
        "Connector bot identity mismatch",
        "Telegram bot identity mismatch",
        "Discord bot identity mismatch",
        "Discord READY bot identity mismatch",
      ].includes(error.message)
    )
      return "identity_mismatch";
    if (
      error.message ===
      "Discord sharding required; single account receiver supports one shard"
    )
      return "shard_requirement";
    if (
      [
        "Discord Gateway authentication, shard or intents requirement failed",
        "Discord authorization or required access unavailable",
      ].includes(error.message) ||
      error.code === "unauthorized"
    )
      return "intents_or_permissions";
  }
  return "provider_unavailable";
}
type State =
  | "disabled"
  | "starting"
  | "receiving"
  | "history_gap"
  | "unavailable"
  | "stopped";
interface Session {
  account: ConnectorAccountConfig;
  state: State;
  reason?: ReadinessReason;
  owner?: ConnectorAccountOwner;
  verified: boolean;
  operationalReady: boolean;
  receiver?: DiscordReceiver;
  telegram?: TelegramReceiver;
  recovery?: Promise<unknown>;
  replies?: ConnectorReplyDispatcher;
  loop?: Promise<void>;
}
/** Application-owned lifecycle. No account is active without explicit local configuration. */
export class ConnectorService {
  private readonly abort = new AbortController();
  private readonly sessions = new Map<string, Session>();
  private readonly dispatcher: ConnectorDispatcher;
  private started = false;
  private sweep?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private readonly config: ConnectorConfig;
  constructor(
    private readonly options: {
      stateRoot: string;
      store: ConnectorStore;
      messaging: MessagingStore;
      config: ConnectorConfig;
      credentials: { account: ConnectorAccountConfig; token: string }[];
      request?: typeof fetch;
      socketFactory?: (url: string) => DiscordSocket;
      readFile?: ConnectorReplyFileReader;
      admitFile?: InboundFileAdmitter;
      admitFiles?: ConstructorParameters<
        typeof ConnectorReplyDispatcher
      >[0]["admitFiles"];
    },
  ) {
    this.config = structuredClone(options.config);
    this.dispatcher = new ConnectorDispatcher({
      ...options,
      canAdmit: (record) =>
        !this.sessions.get(key(record.binding))?.recovery &&
        this.isReady(this.sessions.get(key(record.binding))) &&
        this.config.bindings.some(
          (binding) =>
            binding.id === record.binding.id &&
            binding.enabled &&
            binding.revision === record.binding.revision,
        ),
    });
    for (const binding of this.config.bindings)
      options.store.configure(binding);
    for (const account of this.config.accounts)
      this.sessions.set(key(account), {
        account,
        state: account.enabled ? "starting" : "disabled",
        verified: false,
        operationalReady: false,
      });
  }
  authorized(message: Message): boolean {
    const source = message.external;
    if (!source) return false;
    const binding = this.config.bindings.find((b) => b.id === source.bindingId);
    const session = this.sessions.get(key(source));
    return (
      !!session?.account.enabled &&
      !!binding?.enabled &&
      binding.revision === source.bindingRevision &&
      this.dispatcher.authorized(message)
    );
  }
  ready(message: Message): boolean {
    return (
      !!message.external &&
      this.isReady(this.sessions.get(key(message.external)))
    );
  }
  private isReady(session: Session | undefined): boolean {
    return !!session?.operationalReady && this.isVerified(session);
  }
  private isVerified(session: Session | undefined): boolean {
    if (
      !session?.verified ||
      !session.account.enabled ||
      this.abort.signal.aborted
    )
      return false;
    try {
      session.owner!.assertOwned(session.account);
      const account = this.options.store.getAccount(
        session.account.provider,
        session.account.accountId,
      );
      if (account.credentialGeneration !== session.account.credentialGeneration)
        throw new Error();
      return true;
    } catch {
      session.verified = false;
      session.state = "unavailable";
      return false;
    }
  }
  private async waitForProvider(
    session: Session,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      session.owner!.assertOwned(session.account);
      let deadline = 0;
      try {
        const account = this.options.store.getAccount(
          session.account.provider,
          session.account.accountId,
        );
        if (account.replyRetryBlocked)
          throw new ConnectorError(
            "unavailable",
            "Connector provider retry requires operator review",
          );
        deadline = account.replyRetryNotBefore ?? 0;
      } catch (error) {
        if (!(error instanceof ConnectorError) || error.code !== "not_found")
          throw error;
      }
      if (deadline <= Date.now()) return;
      await delay(Math.min(86400000, deadline - Date.now()), signal);
    }
  }
  private assertSend(session: Session, reply: ConnectorReplyRecord) {
    this.abort.signal.throwIfAborted();
    session.owner!.assertOwned(session.account);
    if (
      !this.isReady(session) ||
      !session.account.enabled ||
      !this.config.bindings.some(
        (b) =>
          b.id === reply.binding.id &&
          b.enabled &&
          b.revision === reply.binding.revision,
      ) ||
      !this.options.store.replyAuthorized(reply.id, identity(session.account))
    )
      throw new ConnectorError(
        "unauthorized",
        "Connector send authority is unavailable",
      );
  }
  start(): void {
    if (this.started || this.abort.signal.aborted) return;
    this.started = true;
    for (const session of this.sessions.values())
      if (session.account.enabled) session.loop = this.receive(session);
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 250);
  }
  private async receive(session: Session) {
    const { store } = this.options,
      signal = this.abort.signal,
      account = session.account;
    try {
      session.owner = new ConnectorAccountOwner({
        stateRoot: this.options.stateRoot,
        ...account,
      });
      const credential = this.options.credentials.find(
        (c) =>
          key(c.account) === key(account) &&
          c.account.credentialGeneration === account.credentialGeneration,
      );
      if (!credential)
        throw new ConnectorError(
          "unavailable",
          "Connector credential is unavailable",
        );
      const rawRequest = this.options.request ?? fetch,
        token = credential.token;
      const request: typeof fetch = async (input, init) => {
        const requestSignal = init?.signal
          ? AbortSignal.any([signal, init.signal])
          : signal;
        await this.waitForProvider(session, requestSignal);
        requestSignal.throwIfAborted();
        return rawRequest(input, { ...init, signal: requestSignal });
      };
      for (;;) {
        try {
          if (account.provider === "telegram") {
            const value = await telegramApi(token, request)(
              "getMe",
              {},
              signal,
            );
            if (
              !value ||
              typeof value !== "object" ||
              !("id" in value) ||
              !("is_bot" in value) ||
              value.is_bot !== true ||
              typeof value.id !== "number" ||
              !Number.isSafeInteger(value.id) ||
              String(value.id) !== account.accountId
            )
              throw new ConnectorError(
                "unauthorized",
                "Connector bot identity mismatch",
              );
          } else {
            const value = await discordGet(
              "/users/@me",
              token,
              request,
              signal,
            );
            if (value.id !== account.accountId || value.bot !== true)
              throw new ConnectorError(
                "unauthorized",
                "Connector bot identity mismatch",
              );
          }
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          if (
            !(error instanceof TelegramRequestError) &&
            !(error instanceof DiscordRetry)
          )
            throw error;
          session.state = "unavailable";
          session.reason = readinessReason(error);
          await delay(Math.max(1000, error.retryAfterMs ?? 5000), signal);
          session.state = "starting";
        }
      }
      signal.throwIfAborted();
      session.owner.assertOwned(account);
      let prior;
      try {
        prior = store.getAccount(account.provider, account.accountId);
      } catch (error) {
        if (!(error instanceof ConnectorError) || error.code !== "not_found")
          throw error;
      }
      const identity = {
        provider: account.provider,
        accountId: account.accountId,
        credentialGeneration: account.credentialGeneration,
      };
      store.configureAccount({
        ...identity,
        ...(prior && prior.credentialGeneration !== account.credentialGeneration
          ? { expectedRevision: prior.revision }
          : {}),
      });
      session.verified = true;
      const replyRequest: typeof fetch = async (input, init) => {
        signal.throwIfAborted();
        init?.signal?.throwIfAborted();
        session.owner!.assertOwned(account);
        const saved = store.getAccount(account.provider, account.accountId);
        if (saved.replyRetryBlocked) throw new ConnectorReplyRateLimitUnknown();
        const remaining = (saved.replyRetryNotBefore ?? 0) - Date.now();
        if (remaining > 0)
          throw new ConnectorReplyRejected(Math.min(86400000, remaining));
        return rawRequest(input, init);
      };
      const transport = (
        account.provider === "telegram"
          ? createTelegramReplyTransport
          : createDiscordReplyTransport
      )({
        account: identity,
        token,
        request: replyRequest,
        readFile: this.options.readFile,
        assertAuthorized: (reply) => this.assertSend(session, reply),
      });
      session.replies = new ConnectorReplyDispatcher({
        store,
        messaging: this.options.messaging,
        owner: session.owner,
        transport,
        admitFiles: this.options.admitFiles,
      });
      const bindings = () =>
        this.config.bindings.filter(
          (b) =>
            b.provider === account.provider &&
            b.accountId === account.accountId,
        );
      if (account.provider === "discord")
        session.receiver = new DiscordReceiver({
          account: identity,
          token,
          owner: session.owner,
          store,
          bindings,
          request,
          socketFactory: this.options.socketFactory,
          onReady: () => {
            session.operationalReady = true;
          },
          admitFile: this.options.admitFile,
        });
      session.telegram =
        account.provider === "telegram"
          ? new TelegramReceiver({
              account: { ...identity, provider: "telegram" },
              token,
              owner: session.owner,
              store,
              bindings,
              request,
              admitFile: this.options.admitFile,
            })
          : undefined;
      await this.receiveLoop(session);
    } catch (error) {
      session.verified = false;
      session.reason = readinessReason(error);
      if (!signal.aborted) session.state = "unavailable";
    }
  }
  private async receiveLoop(session: Session): Promise<void> {
    const signal = this.abort.signal,
      account = session.account,
      store = this.options.store;
    while (!signal.aborted) {
      await this.waitForProvider(session, signal);
      const historyGap = store.getAccount(account.provider, account.accountId)
        .cursor.historyGap;
      if (account.provider === "telegram" && historyGap) {
        session.state = "history_gap";
        break;
      }
      session.state = historyGap ? "history_gap" : "receiving";
      session.reason = historyGap ? "history_gap" : undefined;
      try {
        if (session.telegram) {
          await session.telegram.pollOnce(signal);
          session.operationalReady = true;
        } else {
          session.operationalReady = false;
          const result = await session.receiver!.connectOnce(signal);
          session.operationalReady = false;
          await delay(Math.max(1000, result.retryAfterMs), signal);
        }
      } catch (error) {
        if (signal.aborted) break;
        session.operationalReady = false;
        session.state = "unavailable";
        session.reason = readinessReason(error);
        if (
          account.provider === "telegram" &&
          store.getAccount(account.provider, account.accountId).cursor
            .historyGap
        ) {
          session.state = "history_gap";
          break;
        }
        if (
          error instanceof TelegramRequestError ||
          error instanceof DiscordRetry
        ) {
          await delay(Math.max(1000, error.retryAfterMs ?? 5000), signal);
          continue;
        }
        session.verified = false;
        break;
      }
      await delay(250, signal);
    }
  }
  async recoverHistoryGap(
    input: ConnectorHistoryGapRecovery,
  ): Promise<ReturnType<ConnectorService["snapshot"]>> {
    object(input, ["provider", "accountId", "expectedRevision", "action"]);
    if (
      (input.provider !== "telegram" && input.provider !== "discord") ||
      typeof input.accountId !== "string" ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      input.action !==
        (input.provider === "telegram"
          ? "skip-retained-updates"
          : "acknowledge-gap")
    )
      throw new ConnectorError(
        "invalid",
        "Invalid history gap recovery request",
      );
    const session = this.sessions.get(key(input));
    if (!session || !this.isVerified(session))
      throw new ConnectorError(
        "unauthorized",
        "Verified connector account is unavailable",
      );
    if (session.recovery)
      throw new ConnectorError(
        "conflict",
        "History gap recovery is already active",
      );
    const check = () => {
      this.abort.signal.throwIfAborted();
      if (!this.isVerified(session))
        throw new ConnectorError(
          "unauthorized",
          "Connector recovery authority changed",
        );
      const account = this.options.store.getAccount(
        input.provider,
        input.accountId,
      );
      if (account.revision !== input.expectedRevision)
        throw new ConnectorError("conflict", "History gap revision conflict");
      if (!account.cursor.historyGap)
        throw new ConnectorError("conflict", "Connector has no history gap");
      return account;
    };
    const work = (async () => {
      let account = check();
      if (input.provider === "discord") {
        this.options.store.commitDispositionBatch({
          ...identity(account),
          expectedRevision: account.revision,
          dispositions: [],
          nextCursor: { ...account.cursor, historyGap: false },
        });
        session.state = "receiving";
        session.reason = undefined;
        return this.snapshot();
      }
      if (session.state !== "history_gap" || !session.telegram)
        throw new ConnectorError(
          "conflict",
          "Telegram receiver is not halted for recovery",
        );
      await session.loop;
      await this.sweep?.catch(() => {});
      account = check();
      const credential = this.options.credentials.find(
        (c) =>
          key(c.account) === key(session.account) &&
          c.account.credentialGeneration ===
            session.account.credentialGeneration,
      );
      if (!credential)
        throw new ConnectorError(
          "unavailable",
          "Connector credential is unavailable",
        );
      const request: typeof fetch = async (url, init) => {
        await this.waitForProvider(session, init?.signal ?? this.abort.signal);
        check();
        return (this.options.request ?? fetch)(url, init);
      };
      const updates = await telegramApi(credential.token, request)(
        "getUpdates",
        { offset: -1, limit: 1, timeout: 0 },
        this.abort.signal,
      );
      account = check();
      if (
        !Array.isArray(updates) ||
        updates.length > 1 ||
        account.cursor.kind !== "telegram"
      )
        throw new ConnectorError("invalid", "Invalid Telegram recovery tail");
      const dispositions = updates.map((update) => {
        const result = telegramDisposition(
          update,
          { ...identity(account), provider: "telegram" },
          [],
        );
        return {
          eventId: result.eventId,
          fingerprint: result.fingerprint,
          status: "unsupported_event" as const,
        };
      });
      this.options.store.commitDispositionBatch({
        ...identity(account),
        expectedRevision: account.revision,
        dispositions,
        nextCursor: {
          kind: "telegram",
          nextOffset: dispositions.length
            ? Number(dispositions[0]!.eventId) + 1
            : account.cursor.nextOffset,
          lastSuccessfulPollAt: Date.now(),
          historyGap: false,
        },
      });
      session.state = "receiving";
      session.reason = undefined;
      session.loop = this.receiveLoop(session).catch(() => {
        session.verified = false;
        if (!this.abort.signal.aborted) session.state = "unavailable";
      });
      return this.snapshot();
    })();
    session.recovery = work;
    try {
      return await work;
    } finally {
      session.recovery = undefined;
    }
  }
  tick(): Promise<void> {
    if (this.sweep) return this.sweep;
    if (this.abort.signal.aborted) return Promise.resolve();
    this.sweep = (async () => {
      this.dispatcher.tick();
      for (const session of this.sessions.values())
        if (session.replies && !session.recovery && this.isReady(session)) {
          try {
            await session.replies.tick(this.abort.signal);
          } catch {
            if (!this.abort.signal.aborted) session.state = "unavailable";
          }
        }
    })().finally(() => {
      this.sweep = undefined;
    });
    return this.sweep;
  }
  snapshot() {
    const accounts = [...this.sessions.values()].map((session) => {
      let historyGap = false,
        revision: number | null = null,
        rateLimitBlocked = false,
        retryNotBefore: number | null = null;
      try {
        const account = this.options.store.getAccount(
          session.account.provider,
          session.account.accountId,
        );
        historyGap = account.cursor.historyGap;
        revision = account.revision;
        rateLimitBlocked = account.replyRetryBlocked === true;
        retryNotBefore = account.replyRetryNotBefore ?? null;
      } catch {
        // An account that has not verified yet has no persisted cursor.
      }
      const ready = this.isReady(session);
      return {
        ready,
        identityVerified: this.isVerified(session),
        provider: session.account.provider,
        accountId: session.account.accountId,
        enabled: session.account.enabled,
        state: session.state,
        historyGap,
        revision,
        rateLimitBlocked,
        retryNotBefore,
        reason: rateLimitBlocked
          ? "rate_limit_review"
          : historyGap
            ? "history_gap"
            : (session.reason ?? null),
        dispositionCounts: this.options.store.dispositionCounts(
          session.account.provider,
          session.account.accountId,
        ),
      };
    });
    const replies: ReturnType<ConnectorStore["listReplies"]> = [];
    let after: string | undefined;
    while (true) {
      const page = this.options.store.listReplies({ after, limit: 100 });
      replies.push(...page);
      if (page.length < 100) break;
      after = page.at(-1)!.id;
    }
    return {
      accounts,
      bindings: this.config.bindings.map((b) => ({
        id: b.id,
        provider: b.provider,
        accountId: b.accountId,
        channelId: b.channelId,
        enabled: b.enabled,
      })),
      pausedReplies: replies
        .filter((reply) => {
          const session = this.sessions.get(key(reply.binding));
          if (
            !session ||
            !this.isVerified(session) ||
            !this.config.bindings.some(
              (binding) =>
                binding.id === reply.binding.id &&
                binding.enabled &&
                binding.revision === reply.binding.revision,
            )
          )
            return true;
          try {
            return !this.options.store.replyAuthorized(
              reply.id,
              identity(session.account),
            );
          } catch {
            return true;
          }
        })
        .map((reply) => ({
          id: reply.id,
          bindingId: reply.binding.id,
          provider: reply.binding.provider,
          accountId: reply.binding.accountId,
          channelId: reply.binding.channelId,
        })),
      uncertainReplies: replies
        .filter((r) => r.state === "uncertain")
        .map((r) => ({
          id: r.id,
          bindingId: r.binding.id,
          provider: r.binding.provider,
          accountId: r.binding.accountId,
          channelId: r.binding.channelId,
        })),
    };
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.abort.abort();
      if (this.timer) clearInterval(this.timer);
      await Promise.all(
        [...this.sessions.values()].map(async (session) => {
          await session.receiver?.stop();
          await session.loop;
          await session.recovery?.catch(() => {});
        }),
      );
      await this.sweep?.catch(() => {});
      for (const session of this.sessions.values()) {
        session.owner?.close();
        session.verified = false;
        session.state = "stopped";
      }
    })();
    return this.closing;
  }
}
