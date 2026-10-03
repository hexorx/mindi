import {
  acquireDiscordFiles,
  admitInboundFiles,
  inboundFileBudget,
  InboundFileUnavailable,
  type InboundFileAdmitter,
} from "./inbound-files.js";
import { ConnectorAccountOwner } from "./account-owner.js";
import { ConnectorStore } from "./store.js";
import {
  ConnectorError,
  type ConnectorAccountIdentity,
  type ConnectorBinding,
} from "./types.js";
import { accountIdentity } from "./cursor-validation.js";
import { discordGet, discordGatewayUrl, DiscordRetry } from "./discord-api.js";
import {
  discordId,
  discordObject,
  normalizeDiscordDispatch,
} from "./discord-events.js";
export interface DiscordSocket {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void;
  removeEventListener(
    type: "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void;
}
export interface DiscordReceiverOptions {
  account: ConnectorAccountIdentity;
  token: string;
  owner: ConnectorAccountOwner;
  store: ConnectorStore;
  bindings: () => readonly ConnectorBinding[];
  request?: typeof fetch;
  socketFactory?: (url: string) => DiscordSocket;
  random?: () => number;
  now?: () => number;
  admitFile?: InboundFileAdmitter;
  onReady?: () => void;
}
type ConnectionResult = { retryAfterMs: number };
/** One held account owner, one serial bounded Dispatch journal, no model or reply effects. */
export class DiscordReceiver {
  private active: Promise<ConnectionResult> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private runner: Promise<void> | undefined;
  private readonly shutdown = new AbortController();
  private nextIdentifyAt = 0;
  private readonly account: ConnectorAccountIdentity;
  private readonly request: typeof fetch;
  private readonly random: () => number;
  private readonly now: () => number;
  constructor(private readonly options: DiscordReceiverOptions) {
    this.account = accountIdentity(options.account);
    if (
      this.account.provider !== "discord" ||
      !options.token ||
      options.token.length > 4096 ||
      /[\r\n\0]/.test(options.token)
    )
      throw new ConnectorError(
        "invalid",
        "Invalid Discord receiver configuration",
      );
    this.request = options.request ?? fetch;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.owned();
  }
  private owned() {
    this.options.owner.assertOwned(this.account);
  }
  connectOnce(signal?: AbortSignal): Promise<ConnectionResult> {
    if (this.active)
      return Promise.reject(
        new ConnectorError("conflict", "Discord receiver already active"),
      );
    if (this.stopped || signal?.aborted)
      return Promise.resolve({ retryAfterMs: 0 });
    this.owned();
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.active = this.connect(controller.signal)
      .catch((error) => {
        if (controller.signal.aborted) return { retryAfterMs: 0 };
        if (error instanceof DiscordRetry)
          return { retryAfterMs: error.retryAfterMs };
        throw error;
      })
      .finally(() => {
        signal?.removeEventListener("abort", abort);
        this.active = undefined;
        this.controller = undefined;
      });
    return this.active;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    this.controller?.abort();
    await this.active?.catch(() => {});
    await this.runner?.catch(() => {});
  }
  run(signal?: AbortSignal): Promise<void> {
    if (this.runner || this.active)
      return Promise.reject(
        new ConnectorError("conflict", "Discord receiver already active"),
      );
    const combined = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    this.runner = this.runLoop(combined).finally(() => {
      this.runner = undefined;
    });
    return this.runner;
  }
  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!this.stopped && !signal?.aborted) {
      const { retryAfterMs } = await this.connectOnce(signal);
      if (this.stopped || signal?.aborted) break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.max(1000, retryAfterMs));
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
  }
  private async connect(signal: AbortSignal): Promise<ConnectionResult> {
    const check = () => {
      this.owned();
      if (signal.aborted)
        throw new ConnectorError("unavailable", "Discord receiver stopped");
    };
    const me = await discordGet(
      "/users/@me",
      this.options.token,
      this.request,
      signal,
    );
    check();
    if (me.id !== this.account.accountId || me.bot !== true)
      throw new ConnectorError("unauthorized", "Discord bot identity mismatch");
    let record = this.options.store.configureAccount(this.account);
    // Operator gap acknowledgements and rate-limit metadata may update the account
    // while this socket is active. Adopt only unchanged provider progress.
    const refreshRecord = () => {
      this.owned();
      const current = this.options.store.getAccount(
        this.account.provider,
        this.account.accountId,
      );
      const before = record.cursor,
        after = current.cursor;
      if (
        current.credentialGeneration !== this.account.credentialGeneration ||
        before.kind !== "discord" ||
        after.kind !== "discord" ||
        before.sessionId !== after.sessionId ||
        before.resumeGatewayUrl !== after.resumeGatewayUrl ||
        before.durableSequence !== after.durableSequence
      )
        throw new ConnectorError(
          "conflict",
          "Discord account progress changed outside this receiver",
        );
      record = current;
      return after;
    };
    const gateway = await discordGet(
      "/gateway/bot",
      this.options.token,
      this.request,
      signal,
    );
    check();
    const initial = record.cursor;
    if (initial.kind !== "discord")
      throw new ConnectorError("invalid", "Discord cursor mismatch");
    const resuming =
      initial.sessionId !== null && initial.durableSequence !== null;
    if (gateway.shards !== 1)
      throw new ConnectorError(
        "unavailable",
        "Discord sharding required; single account receiver supports one shard",
      );
    if (!resuming) {
      const limit = discordObject(gateway.session_start_limit);
      if (
        !Number.isSafeInteger(limit.remaining) ||
        (limit.remaining as number) < 0 ||
        !Number.isSafeInteger(limit.reset_after) ||
        (limit.reset_after as number) < 0 ||
        !Number.isSafeInteger(limit.max_concurrency) ||
        (limit.max_concurrency as number) < 1
      )
        throw new ConnectorError(
          "unavailable",
          "Discord session start limits unavailable",
        );
      const wait = Math.max(
        this.nextIdentifyAt - this.now(),
        limit.remaining === 0 ? (limit.reset_after as number) : 0,
      );
      if (wait > 0) return { retryAfterMs: wait };
    }
    const url = discordGatewayUrl(
      resuming ? initial.resumeGatewayUrl : gateway.url,
    );
    const socket = (
      this.options.socketFactory ??
      ((address: string) => new WebSocket(address))
    )(url);
    let closed = false,
      hello = false,
      authenticated = false,
      awaitingAck = false,
      receivedSequence: number | null = initial.durableSequence;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let queued = 0,
      chain: Promise<void> = Promise.resolve();
    const local = new AbortController();
    const requestSignal = AbortSignal.any([signal, local.signal]);
    let finish!: (
      result: ConnectionResult | ConnectorError,
      reset?: boolean,
    ) => void;
    const completion = new Promise<ConnectionResult>((resolve, reject) => {
      finish = (result, reset = false) => {
        if (closed) return;
        closed = true;
        local.abort();
        clearTimeout(heartbeat);
        clearTimeout(handshake);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
        try {
          socket.close(4000);
        } catch {
          /* Socket is already unusable. */
        }
        void chain
          .then(() => {
            if (reset && !signal.aborted) {
              refreshRecord();
              record = this.options.store.commitDispositionBatch({
                ...this.account,
                expectedRevision: record.revision,
                dispositions: [],
                nextCursor: {
                  kind: "discord",
                  sessionId: null,
                  resumeGatewayUrl: null,
                  durableSequence: null,
                  historyGap: true,
                },
              });
            }
            if (result instanceof ConnectorError) reject(result);
            else resolve(result);
          })
          .catch(() =>
            reject(
              new ConnectorError(
                "unavailable",
                "Discord journal could not be updated",
              ),
            ),
          );
      };
    });
    const send = (op: number, d: unknown) => {
      if (!closed) {
        this.owned();
        socket.send(JSON.stringify({ op, d }));
      }
    };
    const heartbeatTick = () => {
      try {
        if (awaitingAck) {
          finish({ retryAfterMs: 1000 });
          return;
        }
        send(1, receivedSequence);
        awaitingAck = true;
      } catch {
        finish(
          new ConnectorError("unavailable", "Discord heartbeat unavailable"),
        );
      }
    };
    const armHeartbeat = (interval: number, delay: number) => {
      heartbeat = setTimeout(() => {
        heartbeatTick();
        if (!closed) armHeartbeat(interval, interval);
      }, delay);
    };
    const commitDispatch = async (packet: Record<string, unknown>) => {
      if (closed) return;
      check();
      const sequence = packet.s as number,
        type = packet.t as string,
        data = discordObject(packet.d);
      if (type === "READY") {
        if (
          resuming ||
          authenticated ||
          discordObject(data.user).id !== this.account.accountId ||
          discordObject(data.user).bot !== true
        )
          throw new ConnectorError(
            "unauthorized",
            "Discord READY bot identity mismatch",
          );
        if (
          typeof data.session_id !== "string" ||
          data.session_id.length > 200 ||
          !data.session_id
        )
          throw new ConnectorError("invalid", "Invalid Discord session");
        const resumeGatewayUrl = discordGatewayUrl(data.resume_gateway_url);
        const disposition = normalizeDiscordDispatch({
          account: this.account,
          sessionId: data.session_id,
          sequence,
          type,
          data: packet.d,
          bindings: [],
        });
        check();
        const currentCursor = refreshRecord();
        record = this.options.store.commitDispositionBatch({
          ...this.account,
          expectedRevision: record.revision,
          dispositions: [disposition],
          nextCursor: {
            kind: "discord",
            sessionId: data.session_id,
            resumeGatewayUrl,
            durableSequence: sequence,
            historyGap: currentCursor.historyGap,
          },
        });
        authenticated = true;
        clearTimeout(handshake);
        this.options.onReady?.();
        return;
      }
      const cursor = record.cursor;
      if (cursor.kind !== "discord" || cursor.sessionId === null)
        throw new ConnectorError(
          "unavailable",
          "Discord Dispatch before READY",
        );
      if (!authenticated && !resuming)
        throw new ConnectorError("unavailable", "Discord session not verified");
      if (sequence < (cursor.durableSequence ?? 0))
        throw new ConnectorError(
          "conflict",
          "Discord Dispatch sequence moved backwards",
        );
      let channel: unknown;
      const author = discordObject(data.author);
      const candidate = this.options
        .bindings()
        .some(
          (binding) =>
            binding.enabled &&
            binding.provider === "discord" &&
            binding.accountId === this.account.accountId &&
            binding.credentialGeneration ===
              this.account.credentialGeneration &&
            binding.chatId === data.channel_id &&
            binding.allowedUserIds.includes(
              typeof author.id === "string" ? author.id : "",
            ),
        );
      if (
        type === "MESSAGE_CREATE" &&
        discordId(data.channel_id) &&
        candidate &&
        author.id !== this.account.accountId &&
        author.bot !== true &&
        data.webhook_id == null
      ) {
        channel = await discordGet(
          `/channels/${data.channel_id}`,
          this.options.token,
          this.request,
          requestSignal,
        );
        if (closed) return;
        check();
      }
      const normalization = {
        account: this.account,
        sessionId: cursor.sessionId,
        sequence,
        type,
        data: packet.d,
        channel,
        bindings: this.options.bindings(),
        resolveReplyReference: this.options.store.resolveReplyReference.bind(
          this.options.store,
        ),
      };
      let disposition = normalizeDiscordDispatch(normalization);
      if (disposition.status === "unsupported_file" && this.options.admitFile) {
        // The empty-ID candidate checks authority only; it cannot enter the journal.
        const candidate = normalizeDiscordDispatch({
          ...normalization,
          attachmentIds: [],
        });
        if (candidate.status === "accepted") {
          let files;
          try {
            files = await acquireDiscordFiles(data, {
              request: this.request,
              signal: requestSignal,
              budget: inboundFileBudget(),
            });
          } catch (error) {
            if (!(error instanceof InboundFileUnavailable)) throw error;
          }
          if (closed) return;
          check();
          if (files) {
            const binding = normalization.bindings.find(
              (row) => row.id === candidate.bindingId,
            )!;
            const attachmentIds = await admitInboundFiles(
              files,
              binding,
              candidate.event,
              this.options.admitFile,
              () => {
                check();
                requestSignal.throwIfAborted();
              },
            );
            if (closed) return;
            if (attachmentIds)
              disposition = normalizeDiscordDispatch({
                ...normalization,
                attachmentIds,
              });
          }
        }
      }
      check();
      const currentCursor = refreshRecord();
      record = this.options.store.commitDispositionBatch({
        ...this.account,
        expectedRevision: record.revision,
        dispositions: [disposition],
        nextCursor: { ...currentCursor, durableSequence: sequence },
      });
      if (type === "RESUMED") {
        authenticated = true;
        clearTimeout(handshake);
        this.options.onReady?.();
      }
    };
    const onMessage = (event: { data?: unknown }) => {
      if (closed) return;
      try {
        check();
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data) > 1024 * 1024
        )
          throw new ConnectorError(
            "invalid",
            "Invalid Discord Gateway payload",
          );
        const packet = discordObject(JSON.parse(event.data));
        if (packet.op === 10) {
          if (hello)
            throw new ConnectorError("invalid", "Repeated Discord HELLO");
          hello = true;
          const interval = discordObject(packet.d).heartbeat_interval;
          if (
            !Number.isSafeInteger(interval) ||
            (interval as number) < 1 ||
            (interval as number) > 300000
          )
            throw new ConnectorError(
              "invalid",
              "Invalid Discord heartbeat interval",
            );
          armHeartbeat(
            interval as number,
            (interval as number) * Math.max(0, Math.min(1, this.random())),
          );
          if (resuming)
            send(6, {
              token: this.options.token,
              session_id: initial.sessionId,
              seq: initial.durableSequence,
            });
          else {
            this.nextIdentifyAt = this.now() + 5000;
            send(2, {
              token: this.options.token,
              intents: 37377,
              properties: {
                os: process.platform,
                browser: "mindi",
                device: "mindi",
              },
            });
          }
        } else if (packet.op === 11) {
          awaitingAck = false;
        } else if (packet.op === 1) {
          send(1, receivedSequence);
          awaitingAck = true;
        } else if (packet.op === 7) {
          finish({ retryAfterMs: 1000 });
        } else if (packet.op === 9) {
          if (typeof packet.d !== "boolean")
            throw new ConnectorError(
              "invalid",
              "Invalid Discord session response",
            );
          finish(
            {
              retryAfterMs:
                1000 +
                Math.floor(Math.max(0, Math.min(1, this.random())) * 4000),
            },
            packet.d === false,
          );
        } else if (packet.op === 0) {
          if (
            !hello ||
            !Number.isSafeInteger(packet.s) ||
            (packet.s as number) < 0 ||
            typeof packet.t !== "string" ||
            packet.t.length > 100
          )
            throw new ConnectorError("invalid", "Invalid Discord Dispatch");
          receivedSequence = packet.s as number;
          if (queued >= 100) {
            finish({ retryAfterMs: 1000 });
            return;
          }
          queued++;
          chain = chain
            .then(() => commitDispatch(packet))
            .catch((error) => {
              if (!closed)
                finish(
                  error instanceof ConnectorError
                    ? error
                    : new ConnectorError(
                        "unavailable",
                        "Discord Dispatch failed",
                      ),
                );
            })
            .finally(() => {
              queued--;
            });
        } else
          throw new ConnectorError(
            "invalid",
            "Unsupported Discord Gateway opcode",
          );
      } catch (error) {
        finish(
          error instanceof ConnectorError
            ? error
            : new ConnectorError("invalid", "Invalid Discord Gateway payload"),
        );
      }
    };
    const onClose = (event: { code?: number }) => {
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code ?? 0))
        finish(
          new ConnectorError(
            "unauthorized",
            "Discord Gateway authentication, shard or intents requirement failed",
          ),
        );
      else
        finish(
          { retryAfterMs: event.code === 4008 ? 5000 : 1000 },
          [4007, 4009, 1000, 1001].includes(event.code ?? 0),
        );
    };
    const onError = () => finish({ retryAfterMs: 1000 });
    const onAbort = () => finish({ retryAfterMs: 0 });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    const handshake = setTimeout(() => finish({ retryAfterMs: 1000 }), 30000);
    if (signal.aborted) onAbort();
    return completion;
  }
}
