import { createHash } from "node:crypto";
import { RuntimeError } from "@mindi/agent-runtime";
import { taskOutputManifest } from "@mindi/agent-runtime/task-outputs";
import type { MessagingStore } from "@mindi/messaging";
import type { RoutineStore } from "@mindi/routines";
import type { TaskStore } from "@mindi/tasks";
import type { TaskOutputStore } from "./task-output-store.js";
/** Operator downloads derive ownership from a published message, never request metadata. */
export class TaskOutputDownloads {
  constructor(
    private readonly options: {
      messaging: MessagingStore;
      routines: RoutineStore;
      tasks: TaskStore;
      outputs: TaskOutputStore;
      profileAvailable: (profileId: string) => boolean;
    },
  ) {}
  content(channelId: string, messageId: string, outputId: string) {
    try {
      const { messaging, routines, tasks } = this.options;
      const message = messaging.getMessage(messageId);
      const channel = messaging.getChannel(channelId);
      const source = message.routineOutput;
      if (
        message.channelId !== channelId ||
        !source ||
        !channel.members.includes("operator") ||
        !channel.members.includes(message.senderId)
      )
        throw Error();
      const occurrence = routines.getOccurrence(source.occurrenceId);
      const publication = routines.getPublication(occurrence.id);
      if (
        !publication ||
        publication.state !== "published" ||
        publication.messageId !== message.id ||
        publication.destination.channelId !== channelId ||
        (publication.destination.branchId ?? null) !==
          (message.branchId ?? null) ||
        occurrence.snapshot.destination?.channelId !== channelId ||
        (occurrence.snapshot.destination.branchId ?? null) !==
          (message.branchId ?? null) ||
        source.routineId !== occurrence.routineId ||
        source.state !== occurrence.state ||
        source.taskId !== occurrence.taskId ||
        source.attemptId !== occurrence.attemptId ||
        !occurrence.attemptId ||
        message.text !== occurrence.summary
      )
        throw Error();
      const attempt = tasks.getAttempt(occurrence.attemptId);
      const profileId = occurrence.snapshot.profileId;
      if (
        !this.options.profileAvailable(profileId) ||
        message.senderId !== `agent:${profileId}` ||
        publication.profileId !== profileId ||
        attempt.snapshot.assignee !== profileId ||
        attempt.snapshot.routineOccurrenceId !== occurrence.id ||
        attempt.taskId !== occurrence.taskId ||
        attempt.state !== occurrence.state ||
        attempt.summary !== occurrence.summary ||
        !attempt.runId ||
        message.runId !== attempt.runId ||
        !attempt.threadId
      )
        throw Error();
      const scope = {
        profileId,
        threadId: attempt.threadId,
        runId: attempt.runId,
        taskId: attempt.taskId,
        attemptId: attempt.id,
      };
      const manifest = taskOutputManifest(attempt.outputs, scope);
      for (const candidate of [occurrence.outputs, message.outputs])
        if (
          JSON.stringify(taskOutputManifest(candidate, scope)) !==
          JSON.stringify(manifest)
        )
          throw Error();
      const metadata = manifest.find((output) => output.id === outputId);
      if (!metadata) throw Error();
      const content = this.options.outputs.content(scope, outputId);
      if (
        JSON.stringify(content.metadata) !== JSON.stringify(metadata) ||
        content.bytes.length !== metadata.size ||
        createHash("sha256").update(content.bytes).digest("hex") !==
          metadata.sha256
      )
        throw Error();
      return { ...metadata, data: content.bytes.toString("base64") };
    } catch {
      throw new RuntimeError("not_found", "Published output unavailable");
    }
  }
}
