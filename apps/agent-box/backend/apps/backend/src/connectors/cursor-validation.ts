import {
  type ConnectorAccountIdentity,
  type ConnectorCursor,
  type ConnectorProvider,
  type ConnectorDispositionInput,
} from "./types.js";
import { object, id, invalid, event } from "./validation.js";
export function accountIdentity(input: unknown): ConnectorAccountIdentity {
  const row = object(input, ["provider", "accountId", "credentialGeneration"]);
  if (row.provider !== "telegram" && row.provider !== "discord")
    invalid("Invalid account provider");
  const accountId = id(row.accountId);
  if (!/^[1-9][0-9]{0,19}$/.test(accountId))
    invalid("Account ID must be a canonical provider bot ID");
  return {
    provider: row.provider,
    accountId,
    credentialGeneration: id(row.credentialGeneration),
  };
}
function natural(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    invalid("Invalid cursor integer");
  return value as number;
}
export function cursor(
  input: unknown,
  provider: ConnectorProvider,
): ConnectorCursor {
  const row = object(
    input,
    provider === "telegram"
      ? ["kind", "nextOffset", "lastSuccessfulPollAt", "historyGap"]
      : [
          "kind",
          "sessionId",
          "resumeGatewayUrl",
          "durableSequence",
          "historyGap",
        ],
  );
  if (row.kind !== provider || typeof row.historyGap !== "boolean")
    invalid("Invalid cursor provider or gap");
  if (provider === "telegram")
    return {
      kind: provider,
      nextOffset: natural(row.nextOffset),
      lastSuccessfulPollAt: natural(row.lastSuccessfulPollAt),
      historyGap: row.historyGap,
    };
  const sessionId = row.sessionId === null ? null : id(row.sessionId);
  let resumeGatewayUrl: string | null = null;
  if (row.resumeGatewayUrl !== null) {
    if (
      typeof row.resumeGatewayUrl !== "string" ||
      row.resumeGatewayUrl.length > 2048
    )
      invalid("Invalid resume URL");
    let url: URL;
    try {
      url = new URL(row.resumeGatewayUrl);
    } catch {
      invalid("Invalid resume URL");
    }
    if (
      url.protocol !== "wss:" ||
      !(
        url.hostname === "gateway.discord.gg" ||
        url.hostname.endsWith(".discord.gg")
      ) ||
      url.username ||
      url.password ||
      url.hash ||
      url.port
    )
      invalid("Invalid resume URL");
    resumeGatewayUrl = row.resumeGatewayUrl;
  }
  const durableSequence = natural(row.durableSequence);
  if (
    (sessionId === null) !== (resumeGatewayUrl === null) ||
    (sessionId === null && durableSequence !== null)
  )
    invalid("Incomplete Discord cursor session");
  return {
    kind: provider,
    sessionId,
    resumeGatewayUrl,
    durableSequence,
    historyGap: row.historyGap,
  };
}
export function initialCursor(
  provider: ConnectorProvider,
  historyGap: boolean,
): ConnectorCursor {
  return provider === "telegram"
    ? {
        kind: provider,
        nextOffset: null,
        lastSuccessfulPollAt: null,
        historyGap,
      }
    : {
        kind: provider,
        sessionId: null,
        resumeGatewayUrl: null,
        durableSequence: null,
        historyGap,
      };
}
export function disposition(input: unknown): ConnectorDispositionInput {
  const row = object(input, [
    "eventId",
    "fingerprint",
    "status",
    "bindingId",
    "bindingRevision",
    "event",
  ]);
  if (
    typeof row.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.fingerprint)
  )
    invalid("Invalid provider payload fingerprint");
  const common = { eventId: id(row.eventId), fingerprint: row.fingerprint };
  if (row.status === "accepted") {
    if (
      !Number.isSafeInteger(row.bindingRevision) ||
      (row.bindingRevision as number) < 1
    )
      invalid("Invalid disposition binding revision");
    return {
      ...common,
      status: "accepted",
      bindingId: id(row.bindingId),
      bindingRevision: row.bindingRevision as number,
      event: event(row.event),
    };
  }
  if (
    ![
      "unauthorized",
      "self_or_bot",
      "unsupported_event",
      "unsupported_file",
      "unsupported_context",
      "content_unavailable",
    ].includes(row.status as string) ||
    "event" in row ||
    "bindingId" in row ||
    "bindingRevision" in row
  )
    invalid("Invalid disposition");
  return {
    ...common,
    status: row.status as Exclude<
      ConnectorDispositionInput["status"],
      "accepted"
    >,
  };
}
