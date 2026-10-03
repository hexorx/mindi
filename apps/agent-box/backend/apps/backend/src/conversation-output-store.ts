import {
  conversationOutputScope,
  type ConversationOutputScope,
} from "@mindi/agent-runtime";
import { TaskOutputStore } from "./task-output-store.js";
/** Same crash-safe byte journal; scope is a native conversation, never a task. */
export class ConversationOutputStore extends TaskOutputStore<ConversationOutputScope> {
  constructor(options: {
    databasePath: string;
    validateScope(scope: ConversationOutputScope): void;
    capture(
      scope: ConversationOutputScope,
      parts: readonly string[],
    ): Promise<Buffer>;
  }) {
    super({ ...options, normalizeScope: conversationOutputScope });
  }
}
