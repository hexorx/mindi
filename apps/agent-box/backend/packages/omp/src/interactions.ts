import type {
  InteractionRequest,
  InteractionResponse,
} from "@mindi/agent-runtime";
import type { Frame } from "./protocol.js";

function text(value: unknown, optional = false): string {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || Buffer.byteLength(value) > 16384)
    throw new Error("Invalid native interaction text");
  return value;
}
/** Translate native UI values without allowing answers outside the offered choices. */
export function nativeInteraction(frame: Frame): {
  request: InteractionRequest;
  response: (answer: InteractionResponse) => Frame;
} {
  const title = text(frame.title);
  if (!title.trim()) throw new Error("Missing native interaction title");
  const detail =
    frame.method === "confirm"
      ? text(frame.message, true)
      : frame.method === "editor"
        ? text(frame.prefill, true)
        : text(frame.placeholder, true);
  const prompt = detail ? `${title}\n\n${detail}` : title;
  if (Buffer.byteLength(prompt) > 16384)
    throw new Error("Native interaction prompt exceeds limit");
  if (
    frame.timeout !== undefined &&
    (!Number.isSafeInteger(frame.timeout) ||
      Number(frame.timeout) <= 0 ||
      Number(frame.timeout) > 1800000)
  )
    throw new Error("Invalid native interaction timeout");
  const timeout =
    frame.timeout === undefined ? {} : { timeoutMs: Number(frame.timeout) };
  let request: InteractionRequest;
  let values: string[] = [];
  if (frame.method === "confirm") {
    request = {
      kind: "choice",
      source: "omp-confirm",
      prompt,
      choices: [
        { id: "confirm", label: "Confirm" },
        { id: "deny", label: "Deny" },
      ],
      ...timeout,
    };
  } else if (frame.method === "select") {
    if (
      !Array.isArray(frame.options) ||
      !frame.options.length ||
      frame.options.length > 32
    )
      throw new Error("Invalid native options");
    values = frame.options.map((value) => text(value));
    if (values.some((value) => !value.trim() || value.length > 256))
      throw new Error("Invalid native option label");
    request = {
      kind: "choice",
      source: "omp-select",
      prompt,
      choices: values.map((label, index) => ({ id: String(index), label })),
      ...timeout,
    };
  } else if (frame.method === "input" || frame.method === "editor") {
    request = {
      kind: "text",
      source: frame.method === "input" ? "omp-input" : "omp-editor",
      prompt,
      ...timeout,
    };
  } else throw new Error("Unsupported native interaction");
  return {
    request,
    response(answer) {
      if ("cancelled" in answer && answer.cancelled === true)
        return { cancelled: true };
      if (request.kind === "text") {
        if (
          !("text" in answer) ||
          typeof answer.text !== "string" ||
          answer.text.length > 4096
        )
          throw new Error("Invalid native text answer");
        return { value: answer.text };
      }
      if (
        !("choiceId" in answer) ||
        !request.choices.some((choice) => choice.id === answer.choiceId)
      )
        throw new Error("Invalid native choice answer");
      return frame.method === "confirm"
        ? { confirmed: answer.choiceId === "confirm" }
        : { value: values[Number(answer.choiceId)] };
    },
  };
}
