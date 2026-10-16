import type { ConversationOutputMetadata } from "@mindi/agent-runtime";
import type { TaskOutputMetadata } from "@mindi/agent-runtime/task-outputs";
export interface ChannelAttachmentScope {
  kind: "channel";
  channelId: string;
  branchId?: string;
  profileId: string;
}
export interface ChannelAttachmentMetadata {
  external?: ExternalProvenance;
  id: string;
  scope: ChannelAttachmentScope;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
}
export type ChannelAttachmentResolver = (
  scope: ChannelAttachmentScope,
  ids: string[],
) => ChannelAttachmentMetadata[];
/** Trusted admission rebinding from an active capability run to an exact recipient. */
export type AgentAttachmentForwarder = (input: {
  runId: string;
  profileId: string;
  attachmentIds: string[];
  idempotencyKey: string;
  scope: ChannelAttachmentScope;
}) => ChannelAttachmentMetadata[];
export class MessagingError extends Error {
  constructor(
    public readonly code:
      "invalid" | "conflict" | "not_found" | "unavailable" | "closed",
    message: string,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}
/** Native identities are `operator`/`agent:<profileId>`; trusted connectors add `external:<hash>`. */
export type MemberId = string;
export interface Channel {
  id: string;
  kind: "channel" | "dm";
  name: string;
  members: MemberId[];
  coordinatorId: MemberId | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface RoutineOutputSource {
  routineId: string;
  occurrenceId: string;
  state: "review" | "blocked" | "cancelled";
  taskId?: string;
  attemptId?: string;
}
export interface PublishRoutineOutput extends RoutineOutputSource {
  outputs?: TaskOutputMetadata[];
  threadId?: string;
  channelId: string;
  branchId?: string;
  profileId: string;
  summary: string;
  runId?: string;
}
export interface ExternalProvenance {
  bindingId: string;
  bindingRevision: number;
  provider: "telegram" | "discord";
  accountId: string;
  chatId: string;
  userId: string;
  conversationId: string;
  messageId: string;
}
export interface ExternalConversationBinding extends Omit<
  ExternalProvenance,
  "userId" | "messageId"
> {
  channelId: string;
  profileId: string;
  allowedUserIds: string[];
}
export interface ExternalAttachmentMetadata extends ChannelAttachmentMetadata {
  external: ExternalProvenance;
}
export type ExternalAttachmentResolver = (
  scope: ChannelAttachmentScope,
  provenance: ExternalProvenance,
  ids: string[],
) => ExternalAttachmentMetadata[];
export interface AdmitExternalMessage {
  replyToNativeMessageId?: string;
  attachmentIds?: string[];
  provenance: ExternalProvenance;
  text: string;
}
export interface DeploymentNotificationSource {
  eventId: string;
  deploymentId: string;
  connectionId: string;
  endpoint: string;
  result: "connectionPublished" | "connectionRevoked";
  occurredAt: number;
  name: string;
  image: string;
}
export interface PublishDeploymentNotification extends DeploymentNotificationSource {
  channelId: string;
}
export interface Message {
  deploymentNotification?: DeploymentNotificationSource;
  taskDiscussion?: TaskDiscussionSource;
  conversationOutputs?: ConversationOutputMetadata[];
  external?: ExternalProvenance;
  outputs?: TaskOutputMetadata[];
  attachmentIds?: string[];
  attachments?: ChannelAttachmentMetadata[];
  routineOutput?: RoutineOutputSource;
  branchId?: string;
  id: string;
  channelId: string;
  senderId: MemberId;
  recipientId: MemberId | null;
  text: string;
  replyTo: string | null;
  runId?: string;
  truncated?: true;
  rootId: string;
  hop: number;
  createdAt: number;
}
export interface TaskDiscussionSource {
  discussionId: string;
  taskId: string;
  boardId: string;
}
export interface PublishTaskDiscussionAnchor extends TaskDiscussionSource {
  channelId: string;
  title: string;
  createdAt: string;
}
export interface CreateChannel {
  name: string;
  members: MemberId[];
  coordinatorId?: MemberId | null;
  idempotencyKey: string;
}
export interface UpdateChannel {
  expectedRevision: number;
  name?: string;
  members?: MemberId[];
  coordinatorId?: MemberId | null;
}
export interface PostMessage {
  attachmentIds?: string[];
  branchId?: string | null;
  channelId: string;
  senderId: MemberId;
  recipientId?: MemberId | null;
  text: string;
  replyTo?: string;
  idempotencyKey: string;
}
export interface PageInput {
  after?: string;
  limit?: number;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Conversation {
  branchId?: string;
  channelId: string;
  profileId: string;
  threadId: string;
}
export interface Delivery {
  branchId?: string;
  id: string;
  messageId: string;
  channelId: string;
  profileId: string;
  state:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "attention_required"
    | "blocked";
  threadId?: string;
  runId?: string;
  output?: string;
  outputTruncated?: boolean;
  replyMessageId?: string;
  reason?: string;
  createdAt: number;
  endedAt?: number;
  cancellationRequestedAt?: number;
}
export interface FinishDelivery {
  conversationOutputs?: ConversationOutputMetadata[];
  runId: string;
  state: "completed" | "failed" | "cancelled" | "attention_required";
  output: string;
  outputTruncated: boolean;
  reason?: string;
}

/** Native identity is supplied by the trusted service, never the tool payload. */
export interface PostAgentMessage extends Omit<PostMessage, "senderId"> {
  runId: string;
  profileId: string;
}

export interface ChannelBranch {
  parentMessageId?: string;
  id: string;
  channelId: string;
  name: string;
  parentBranchId: string | null;
  createdAt: number;
}
export interface CreateBranch {
  parentMessageId?: string;
  channelId: string;
  name: string;
  parentBranchId?: string | null;
  idempotencyKey: string;
}
export interface BranchFork {
  replyToRunId?: string;
  replyToRole?: "user" | "assistant";
  id: string;
  branchId: string;
  channelId: string;
  profileId: string;
  parentThreadId: string;
  entryId: string;
  state: "pending" | "completed" | "cancelled";
  forkOperationId?: string;
  threadId?: string;
  reason?: string;
  createdAt: number;
}
export interface BeginBranchFork {
  replyToRunId?: string;
  replyToRole?: "user" | "assistant";
  branchId: string;
  profileId: string;
  parentThreadId: string;
  entryId: string;
  idempotencyKey: string;
}
