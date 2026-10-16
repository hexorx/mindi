import { createHash } from "node:crypto";
import {
  RuntimeError,
  conversationOutputManifest,
  type AgentRuntime,
} from "@mindi/agent-runtime";
import type { MessagingStore } from "@mindi/messaging";
import type { ConversationOutputStore } from "./conversation-output-store.js";
/** Download authority comes from the native reply and its exact completed run. */
export class ConversationOutputDownloads {
  constructor(
    private readonly options: {
      runtime: AgentRuntime;
      messaging: MessagingStore;
      outputs: Pick<ConversationOutputStore, "content">;
    },
  ) {}
  content(channelId: string, messageId: string, outputId: string) {
    try {
      const { runtime, messaging } = this.options,
        channel = messaging.getChannel(channelId),
        message = messaging.getMessage(messageId);
      if (
        message.channelId !== channelId ||
        !message.runId ||
        !message.replyTo ||
        message.routineOutput ||
        !message.senderId.startsWith("agent:") ||
        !channel.members.includes("operator") ||
        !channel.members.includes(message.senderId)
      )
        throw Error();
      const profileId = message.senderId.slice(6);
      runtime.getProfile(profileId);
      const original = messaging.getMessage(message.replyTo),
        delivery = messaging.getDelivery(original.id),
        run = runtime.getRun(message.runId),
        thread = runtime.getThread(run.threadId);
      if (
        delivery.state !== "completed" ||
        delivery.replyMessageId !== messageId ||
        delivery.runId !== run.id ||
        delivery.profileId !== profileId ||
        delivery.threadId !== thread.id ||
        run.state !== "completed" ||
        run.conversation?.channelId !== channelId ||
        (run.conversation?.branchId ?? null) !== (message.branchId ?? null) ||
        original.channelId !== channelId ||
        (original.branchId ?? null) !== (message.branchId ?? null) ||
        message.recipientId !== original.senderId ||
        thread.profileId !== profileId ||
        thread.owner?.kind !== "channel" ||
        thread.owner.id !== channelId ||
        messaging.getConversation(channelId, profileId, message.branchId)
          ?.threadId !== thread.id
      )
        throw Error();
      const scope = {
        profileId,
        threadId: thread.id,
        runId: run.id,
        channelId,
        ...(message.branchId ? { branchId: message.branchId } : {}),
      };
      const manifest = conversationOutputManifest(
        run.conversationOutputs,
        scope,
      );
      if (
        JSON.stringify(
          conversationOutputManifest(message.conversationOutputs, scope),
        ) !== JSON.stringify(manifest)
      )
        throw Error();
      const file = manifest.find((value) => value.id === outputId);
      if (!file) throw Error();
      const content = this.options.outputs.content(scope, outputId);
      if (
        JSON.stringify(content.metadata) !== JSON.stringify(file) ||
        content.bytes.byteLength !== file.size ||
        createHash("sha256").update(content.bytes).digest("hex") !== file.sha256
      )
        throw Error();
      return { ...file, data: content.bytes.toString("base64") };
    } catch {
      throw new RuntimeError("not_found", "Conversation output unavailable");
    }
  }
}
