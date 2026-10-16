import { randomUUID } from "node:crypto";
import type { PermissionRequest } from "@mindi/acp";
import { requestInteractionBridge } from "./bridge-client.js";

/** ACP semantics originate here; generic native selectors cannot assert permission. */
export async function permissionAnswer(
  request: PermissionRequest,
  signal?: AbortSignal,
): Promise<string | null> {
  if (
    signal?.aborted ||
    new Set(request.options.map((option) => option.optionId)).size !==
      request.options.length
  )
    return null;
  const offered = request.options.filter(
    (option) => option.kind === "allow_once" || option.kind === "reject_once",
  );
  if (
    !offered.length ||
    offered.length > 32 ||
    offered.some(
      (option) =>
        !option.optionId.trim() ||
        Buffer.byteLength(option.optionId) > 128 ||
        !option.name.trim() ||
        Buffer.byteLength(option.name) > 1024,
    )
  )
    return null;
  const detail = JSON.stringify(request.toolCall);
  if (Buffer.byteLength(detail) > 12000) return null;
  const answer = await requestInteractionBridge({
    route: "permission",
    label: "Permission",
    url: process.env.MINDI_CLAUDE_PERMISSION_URL,
    token: process.env.MINDI_CLAUDE_PERMISSION_TOKEN,
    callId: randomUUID(),
    signal,
    request: {
      kind: "choice",
      prompt: `Claude requests permission\n${detail}`,
      choices: offered.map((option) => ({
        id: option.optionId,
        label: option.name,
      })),
      timeoutMs: 120000,
    },
  });
  if (
    signal?.aborted ||
    !answer ||
    typeof answer !== "object" ||
    Array.isArray(answer) ||
    Object.keys(answer).length !== 1 ||
    !("choiceId" in answer) ||
    typeof answer.choiceId !== "string" ||
    !offered.some((option) => option.optionId === answer.choiceId)
  )
    return null;
  return answer.choiceId;
}
