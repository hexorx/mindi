import {
  acquireTelegramFiles,
  admitInboundFiles,
  inboundFileBudget,
  InboundFileUnavailable,
  type InboundFileAdmitter,
} from "./inbound-files.js";
import { telegramId } from "../telegram-routine-delivery.js";
import type { ConnectorAccountOwner } from "./account-owner.js";
import { ConnectorStore } from "./store.js";
import {
  ConnectorError,
  type ConnectorAccountRecord,
  type ConnectorBinding,
} from "./types.js";
import { id } from "./validation.js";
import { telegramDisposition } from "./telegram-events.js";
import { telegramApi } from "./telegram-api.js";
type TelegramAccount = {
  provider: "telegram";
  accountId: string;
  credentialGeneration: string;
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConnectorError("unavailable", "Invalid Telegram response");
  return value as Record<string, unknown>;
}
/** One long-poll iteration; service lifecycle owns retries and the account lease. */
export class TelegramReceiver {
  private readonly account: TelegramAccount;
  private readonly api: ReturnType<typeof telegramApi>;
  private initialized = false;
  private polling = false;
  constructor(
    private readonly options: {
      account: TelegramAccount;
      token: string;
      owner: ConnectorAccountOwner;
      store: ConnectorStore;
      bindings: () => readonly ConnectorBinding[];
      request?: typeof fetch;
      now?: () => number;
      admitFile?: InboundFileAdmitter;
    },
  ) {
    if (
      options.account.provider !== "telegram" ||
      !telegramId(options.account.accountId, true)
    )
      throw new ConnectorError("invalid", "Invalid Telegram bot identity");
    this.account = Object.freeze({
      provider: "telegram",
      accountId: options.account.accountId,
      credentialGeneration: id(options.account.credentialGeneration),
    });
    this.api = telegramApi(options.token, options.request);
  }
  private assertOwned(signal: AbortSignal) {
    signal.throwIfAborted();
    this.options.owner.assertOwned(this.account);
  }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new ConnectorError("invalid", "Invalid receiver clock");
    return now;
  }
  async pollOnce(signal: AbortSignal): Promise<ConnectorAccountRecord> {
    if (this.polling)
      throw new ConnectorError("conflict", "Telegram poll already in progress");
    this.polling = true;
    try {
      this.assertOwned(signal);
      if (!this.initialized) {
        const bot = record(await this.api("getMe", {}, signal));
        this.assertOwned(signal);
        if (
          bot.is_bot !== true ||
          typeof bot.id !== "number" ||
          !Number.isSafeInteger(bot.id) ||
          String(bot.id) !== this.account.accountId
        )
          throw new ConnectorError(
            "unauthorized",
            "Telegram bot identity mismatch",
          );
        const webhook = record(await this.api("getWebhookInfo", {}, signal));
        this.assertOwned(signal);
        if (webhook.url !== "")
          throw new ConnectorError(
            "conflict",
            "Telegram webhook must be resolved before polling",
          );
        // Rotation requires explicit account configuration CAS, never a stale receiver.
        this.options.store.configureAccount(this.account);
        this.initialized = true;
      }
      const account = this.options.store.getAccount(
        "telegram",
        this.account.accountId,
      );
      if (account.credentialGeneration !== this.account.credentialGeneration)
        throw new ConnectorError(
          "unauthorized",
          "Telegram credential generation changed",
        );
      if (account.cursor.kind !== "telegram")
        throw new ConnectorError("conflict", "Telegram cursor mismatch");
      const cursor = account.cursor;
      if (cursor.historyGap)
        throw new ConnectorError(
          "unavailable",
          "Telegram history gap requires explicit recovery",
        );
      if (
        cursor.lastSuccessfulPollAt !== null &&
        this.now() - cursor.lastSuccessfulPollAt > 86400000
      ) {
        this.options.store.commitDispositionBatch({
          ...this.account,
          expectedRevision: account.revision,
          dispositions: [],
          nextCursor: { ...cursor, historyGap: true },
        });
        throw new ConnectorError(
          "unavailable",
          "Telegram history gap requires explicit recovery",
        );
      }
      const result = await this.api(
        "getUpdates",
        {
          ...(cursor.nextOffset === null ? {} : { offset: cursor.nextOffset }),
          limit: 100,
          timeout: 20,
          allowed_updates: ["message"],
        },
        signal,
      );
      this.assertOwned(signal);
      if (!Array.isArray(result) || result.length > 100)
        throw new ConnectorError(
          "unavailable",
          "Invalid Telegram update batch",
        );
      const bindings = this.options.bindings();
      const normalization = {
        resolveReplyReference: this.options.store.resolveReplyReference.bind(
          this.options.store,
        ),
      };
      const dispositions = [];
      for (const update of result) {
        let disposition = telegramDisposition(
          update,
          this.account,
          bindings,
          normalization,
        );
        if (
          disposition.status === "unsupported_file" &&
          this.options.admitFile
        ) {
          // This candidate is only an authority check. It is never committed without admitted IDs.
          const candidate = telegramDisposition(
            update,
            this.account,
            bindings,
            { ...normalization, attachmentIds: [] },
          );
          if (candidate.status === "accepted") {
            let files;
            try {
              files = await acquireTelegramFiles(
                record(record(update).message),
                {
                  token: this.options.token,
                  request: this.options.request,
                  signal,
                  budget: inboundFileBudget(),
                },
              );
            } catch (error) {
              if (!(error instanceof InboundFileUnavailable)) throw error;
            }
            this.assertOwned(signal);
            if (files) {
              const binding = bindings.find(
                (row) => row.id === candidate.bindingId,
              )!;
              const attachmentIds = await admitInboundFiles(
                files,
                binding,
                candidate.event,
                this.options.admitFile,
                () => this.assertOwned(signal),
              );
              if (attachmentIds)
                disposition = telegramDisposition(
                  update,
                  this.account,
                  bindings,
                  { ...normalization, attachmentIds },
                );
            }
          }
        }
        this.assertOwned(signal);
        dispositions.push(disposition);
      }
      dispositions.sort((a, b) => Number(a.eventId) - Number(b.eventId));
      const nextOffset = dispositions.length
        ? Math.max(
            cursor.nextOffset ?? 0,
            Number(dispositions.at(-1)!.eventId) + 1,
          )
        : cursor.nextOffset;
      return this.options.store.commitDispositionBatch({
        ...this.account,
        expectedRevision: account.revision,
        dispositions,
        nextCursor: {
          kind: "telegram",
          nextOffset,
          lastSuccessfulPollAt: Math.max(
            cursor.lastSuccessfulPollAt ?? 0,
            this.now(),
          ),
          historyGap: false,
        },
      });
    } finally {
      this.polling = false;
    }
  }
}
