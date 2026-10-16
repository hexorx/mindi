export type ConnectorProvider = "telegram" | "discord";
/** Provisioned authority; provider input cannot create or edit a binding. */
export interface ConnectorBinding {
  id: string;
  revision: number;
  enabled: boolean;
  provider: ConnectorProvider;
  accountId: string;
  credentialGeneration: string;
  chatId: string;
  conversationId: string;
  allowedUserIds: string[];
  profileId: string;
  channelId: string;
}
/** Normalized by a verified receiver, never accepted from the operator HTTP API. */
export interface ConnectorEvent {
  attachmentIds?: string[];
  replyToNativeMessageId?: string;
  provider: ConnectorProvider;
  accountId: string;
  credentialGeneration: string;
  eventId: string;
  chatId: string;
  conversationId: string;
  messageId: string;
  userId: string;
  text: string;
}
export interface ConnectorInboxRecord {
  id: string;
  binding: ConnectorBinding;
  event: ConnectorEvent;
  state: "accepted" | "admitted" | "closed" | "revoked";
  outcome?: ConnectorNativeFailure;
  revokedAt?: number;
  nativeMessageId?: string;
  replyId?: string;
  createdAt: number;
}
export class ConnectorError extends Error {
  constructor(
    readonly code:
      "invalid" | "conflict" | "unauthorized" | "unavailable" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface ConnectorNativeFailure {
  nativeMessageId: string;
  state: "failed" | "cancelled" | "blocked";
  reason: string;
}

export type ConnectorCursor =
  | {
      kind: "telegram";
      nextOffset: number | null;
      lastSuccessfulPollAt: number | null;
      historyGap: boolean;
    }
  | {
      kind: "discord";
      sessionId: string | null;
      resumeGatewayUrl: string | null;
      durableSequence: number | null;
      historyGap: boolean;
    };
export interface ConnectorAccountIdentity {
  provider: ConnectorProvider;
  accountId: string;
  credentialGeneration: string;
}
export interface ConnectorAccountRecord extends ConnectorAccountIdentity {
  replyRetryNotBefore?: number;
  replyRetryBlocked?: boolean;
  revision: number;
  cursor: ConnectorCursor;
}
export type ConnectorDispositionStatus =
  | "accepted"
  | "unauthorized"
  | "self_or_bot"
  | "unsupported_event"
  | "unsupported_file"
  | "unsupported_context"
  | "content_unavailable";
export type ConnectorDispositionInput = {
  eventId: string;
  fingerprint: string;
} & (
  | {
      status: "accepted";
      bindingId: string;
      bindingRevision: number;
      event: ConnectorEvent;
    }
  | { status: Exclude<ConnectorDispositionStatus, "accepted"> }
);
export interface ConnectorDispositionRecord extends ConnectorAccountIdentity {
  seq: number;
  eventId: string;
  fingerprint: string;
  status: ConnectorDispositionStatus;
  inboxId?: string;
  createdAt: number;
}
export interface ConnectorDispositionBatch extends ConnectorAccountIdentity {
  expectedRevision: number;
  dispositions: ConnectorDispositionInput[];
  nextCursor: ConnectorCursor;
}

export interface ConnectorReplyFile {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
}
export interface ConnectorReplyInput {
  nativeMessageId: string;
  nativeDeliveryId: string;
  runId: string;
  replyMessageId?: string;
  text: string;
  files: ConnectorReplyFile[];
}
export type ConnectorReplyOperationSpec = { id: string } & (
  { kind: "text"; text: string } | { kind: "file"; fileId: string }
);
export interface ConnectorReplyReceipt {
  provider: ConnectorProvider;
  accountId: string;
  chatId: string;
  conversationId: string;
  messageId: string;
}
export type ConnectorReplyOperation = ConnectorReplyOperationSpec & {
  state: "planned" | "in_flight" | "confirmed" | "uncertain";
  receipt?: ConnectorReplyReceipt;
};
export interface ConnectorReplyRecord extends ConnectorReplyInput {
  retryNotBefore?: number;
  id: string;
  inboxId: string;
  binding: ConnectorBinding;
  event: ConnectorEvent;
  state: "planned" | "sending" | "uncertain" | "completed";
  operations: ConnectorReplyOperation[];
  planned: boolean;
  createdAt: number;
}
