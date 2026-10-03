import {
  conversationOutputScope,
  type ConversationOutputScope,
} from "@mindi/agent-runtime";
import { TaskOutputExports } from "./task-output-exports.js";
/** Reuses pinned Linux descriptor-relative capture with native conversation ownership. */
export class ConversationOutputExports extends TaskOutputExports<ConversationOutputScope> {
  constructor(options: {
    databasePath: string;
    exportRoot: string;
    validateScope(scope: ConversationOutputScope): void;
  }) {
    super({ ...options, normalizeScope: conversationOutputScope });
  }
}
