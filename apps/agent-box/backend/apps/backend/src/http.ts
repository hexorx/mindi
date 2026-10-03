import { routeInteractionHistory } from "./interaction-history-http.js";
import { receiveGitHubPush, readGitHubPushes } from "./github-push-http.js";
import type { GitHubPushes } from "./github-pushes.js";
import type { ConversationOutputDownloads } from "./conversation-output-downloads.js";
import { ConnectorError } from "./connectors/types.js";
import type { ConnectorService } from "./connectors/service.js";
import type { TaskOutputDownloads } from "./task-output-downloads.js";
import { routeAttachments } from "./attachment-http.js";
import type { AttachmentStore } from "./attachments.js";
import { routeCoordinatorUpdates } from "./coordinator-http.js";
import type { CoordinatorUpdates } from "./coordinator-updates.js";
import { routeVoice } from "./voice-http.js";
import type { VoiceService } from "./voice-service.js";
import { routeDelegations } from "./delegation-http.js";
import type { DelegationService } from "./delegation-service.js";
import { routeStatus } from "./status-http.js";
import type { StatusProjection } from "./status-projection.js";
import { ArtifactError, type ArtifactStore } from "./artifacts.js";
import { routeArtifacts } from "./artifact-http.js";
import { routeHistory, publicThread } from "./history-http.js";
import { reconcileThreadOwnership } from "./thread-ownership.js";
import {
  DesktopError,
  DesktopOperator,
  attachDesktopViewer,
  type DesktopService,
} from "@mindi/desktop";
import { routeDesktops } from "./desktop-http.js";
import type { TaskDispatcher, TaskRunner } from "@mindi/task-runner";
import { readJsonBody as body } from "./http-body.js";
import { routeTasks } from "./task-http.js";
import type { TaskDiscussionPublisher } from "./task-discussions.js";
import { TaskError, type TaskStore } from "@mindi/tasks";
import {
  RoutineError,
  type RoutineStore,
  type RoutineScheduler,
  type RoutinePublisher,
  type RoutineDeliveryPublisher,
} from "@mindi/routines";
import { routeRoutines } from "./routine-http.js";
import type { routineDestinationChoices } from "./routine-destinations.js";
import { MessagingError, type MessagingStore } from "@mindi/messaging";
import { routeMessaging } from "./messaging-http.js";
import type { MessageRunner } from "@mindi/message-runner";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  RuntimeError,
  isApprovalMode,
  type AgentRuntime,
  type Thread,
  type InteractionResponse,
} from "@mindi/agent-runtime";
export interface BackendOptions {
  githubPushes?: GitHubPushes;
  connectors?: ConnectorService;
  conversationOutputDownloads?: ConversationOutputDownloads;
  taskOutputDownloads?: TaskOutputDownloads;
  routineDestinations?: () => ReturnType<typeof routineDestinationChoices>;
  coordinatorUpdates?: CoordinatorUpdates;
  voice?: VoiceService;
  delegations?: DelegationService;
  status?: StatusProjection;
  artifacts?: ArtifactStore;
  attachments?: AttachmentStore;
  desktops?: DesktopService;
  messaging?: MessagingStore;
  messageRunner?: MessageRunner;
  runtime: AgentRuntime;
  tasks?: TaskStore;
  runner?: TaskRunner;
  dispatcher?: TaskDispatcher;
  taskDiscussionPublisher?: TaskDiscussionPublisher;
  routines?: RoutineStore;
  routineScheduler?: RoutineScheduler;
  routinePublisher?: RoutinePublisher;
  routineDeliveryPublisher?: RoutineDeliveryPublisher;
  token: string;
  port?: number;
  host?: "127.0.0.1" | "0.0.0.0";
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(
    JSON.stringify(value, (key, item) =>
      key === "workerAttachmentSources" || key === "workerAttachmentMetadata"
        ? undefined
        : item,
    ),
  );
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.length)
    throw new RuntimeError("invalid", "Expected nonempty string");
  return value;
}
export async function startBackend(options: BackendOptions) {
  if (options.token.length < 32)
    throw new Error("Backend token must contain at least 32 characters");
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "0.0.0.0")
    throw new Error("Invalid backend bind address");
  reconcileThreadOwnership(options);
  const expected = Buffer.from(`Bearer ${options.token}`);
  const operator = options.desktops
    ? new DesktopOperator(options.desktops)
    : undefined;
  const authenticate = (request: IncomingMessage) => {
    const actual = Buffer.from(request.headers.authorization ?? "");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  };
  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/integrations/github/push") {
      const result = await receiveGitHubPush(
        options.githubPushes,
        request,
        url,
      );
      json(response, result.status, result.value);
      return;
    }
    if (!authenticate(request)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const interactionHistory = routeInteractionHistory(
      options.runtime,
      request,
      url,
    );
    if (interactionHistory) {
      json(response, 200, interactionHistory.value);
      return;
    }
    if (url.pathname === "/activity/github-pushes") {
      const result = readGitHubPushes(options.githubPushes, request, url);
      json(response, result.status, result.value);
      return;
    }
    const updateResult = await routeCoordinatorUpdates(
      options.coordinatorUpdates,
      request,
      url,
    );
    if (updateResult) {
      json(response, 200, updateResult.value);
      return;
    }
    const voiceResult = await routeVoice(options.voice, request, url);
    if (voiceResult) {
      json(response, voiceResult.status ?? 200, voiceResult.value);
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.pathname === "/connectors" &&
      request.method === "GET" &&
      options.connectors
    ) {
      if (url.search)
        throw new RuntimeError("invalid", "Invalid connector status query");
      json(response, 200, options.connectors.snapshot());
      return;
    }
    if (
      url.pathname === "/connectors/history-gap/recover" &&
      request.method === "POST" &&
      options.connectors
    ) {
      if (url.search)
        throw new RuntimeError("invalid", "Invalid connector recovery query");
      try {
        const input = await body(request, [
          "provider",
          "accountId",
          "expectedRevision",
          "action",
        ]);
        const { provider, action, expectedRevision } = input;
        if (
          (provider !== "telegram" && provider !== "discord") ||
          (action !== "skip-retained-updates" &&
            action !== "acknowledge-gap") ||
          typeof expectedRevision !== "number" ||
          !Number.isSafeInteger(expectedRevision) ||
          expectedRevision < 1
        )
          throw new RuntimeError(
            "invalid",
            "Invalid connector recovery request",
          );
        json(
          response,
          200,
          await options.connectors.recoverHistoryGap({
            provider,
            accountId: string(input.accountId),
            expectedRevision,
            action,
          }),
        );
      } catch (error) {
        if (error instanceof ConnectorError) {
          json(
            response,
            error.code === "invalid"
              ? 400
              : error.code === "unauthorized"
                ? 403
                : error.code === "not_found"
                  ? 404
                  : error.code === "conflict"
                    ? 409
                    : 503,
            { error: error.message },
          );
        } else throw error;
      }
      return;
    }
    if (
      options.conversationOutputDownloads &&
      request.method === "GET" &&
      parts.length === 7 &&
      parts[0] === "channels" &&
      parts[2] === "messages" &&
      parts[4] === "conversation-outputs" &&
      parts[6] === "content"
    ) {
      if (
        url.search ||
        url.pathname !== `/${parts.join("/")}` ||
        [parts[1], parts[3], parts[5]].some(
          (id) => !/^[A-Za-z0-9_-]{1,200}$/.test(id!),
        )
      )
        throw new RuntimeError("invalid", "Invalid conversation output route");
      json(
        response,
        200,
        options.conversationOutputDownloads.content(
          parts[1]!,
          parts[3]!,
          parts[5]!,
        ),
      );
      return;
    }
    if (
      url.pathname === "/routine-destinations" &&
      request.method === "GET" &&
      options.routineDestinations
    ) {
      if (url.search)
        throw new RoutineError("invalid", "Invalid routine destination query");
      json(response, 200, { items: options.routineDestinations() });
      return;
    }
    if (options.status) {
      const result = await routeStatus(options.status, request, url);
      if (result) {
        json(response, 200, result.value);
        return;
      }
    }
    if (options.delegations) {
      const result = await routeDelegations(options.delegations, request, url);
      if (result) {
        json(response, 200, result.value);
        return;
      }
    }
    const history = routeHistory(options.runtime, request, url);
    if (history) {
      for (const [key, value] of Object.entries(history.headers ?? {}))
        response.setHeader(key, value);
      json(response, 200, history.value);
      return;
    }
    if (
      options.taskOutputDownloads &&
      parts.length === 7 &&
      parts[0] === "channels" &&
      parts[2] === "messages" &&
      parts[4] === "outputs" &&
      parts[6] === "content" &&
      request.method === "GET"
    ) {
      if (
        url.search ||
        url.pathname !== `/${parts.join("/")}` ||
        [parts[1], parts[3], parts[5]].some(
          (id) => !/^[A-Za-z0-9_-]{1,200}$/.test(id!),
        )
      )
        throw new RuntimeError("invalid", "Invalid output download route");
      json(
        response,
        200,
        options.taskOutputDownloads.content(parts[1]!, parts[3]!, parts[5]!),
      );
      return;
    }
    if (options.attachments) {
      const result = await routeAttachments(options.attachments, request, url);
      if (result) {
        json(response, result.status, result.value);
        return;
      }
    }
    if (options.artifacts) {
      const result = await routeArtifacts(options.artifacts, request, url);
      if (result) {
        json(response, result.status, result.value);
        return;
      }
    }
    if (options.desktops) {
      const result = await routeDesktops(
        options.desktops,
        request,
        url,
        operator,
      );
      if (result) {
        json(response, result.status, result.value);
        return;
      }
    }
    if (options.messaging) {
      const result = await routeMessaging(
        options.messaging,
        request,
        url,
        options.messageRunner,
      );
      if (result) {
        json(response, result.status, result.value);
        return;
      }
    }
    if (options.routines && options.tasks && options.routineScheduler) {
      const result = await routeRoutines(
        options.routines,
        options.tasks,
        options.routineScheduler,
        request,
        url,
        options.routinePublisher,
        options.routineDeliveryPublisher,
      );
      if (result) {
        json(response, result.status, result.value);
        return;
      }
    }
    if (options.tasks) {
      const result = await routeTasks(
        options.tasks,
        request,
        url,
        options.runner,
        options.dispatcher,
        options.taskDiscussionPublisher,
      );
      if (result) {
        json(response, result.status, result.value);
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, {
        status: "ok",
        protocolVersion: 1,
        capabilities: {
          ...(options.githubPushes
            ? {
                githubPushActivity: 1,
                githubPushIntake: options.githubPushes.enabled ? 1 : 0,
              }
            : {}),
          interactionActivity: 1,
          threadOwnership: 1,
          runtimePagination: 1,
          ...(options.status ? { statusProjection: 1 } : {}),
          ...(options.delegations
            ? {
                delegations: 1,
                delegationViews: 1,
                viewerHistory: 1,
                viewerActivity: 1,
              }
            : {}),
          ...(options.artifacts ? { operatorArtifacts: 1 } : {}),
          ...(options.messaging ? { deploymentNotifications: 1 } : {}),
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/profiles") {
      json(response, 200, options.runtime.listProfiles());
      return;
    }
    if (request.method === "POST" && url.pathname === "/profiles") {
      const input = await body(request, ["id", "templateId", "instructions"]);
      json(
        response,
        201,
        options.runtime.createProfile({
          id: string(input.id),
          templateId: string(input.templateId),
          instructions: string(input.instructions),
        }),
      );
      return;
    }
    if (
      parts[0] === "profiles" &&
      parts.length === 2 &&
      parts[1] &&
      request.method === "GET"
    ) {
      json(response, 200, options.runtime.getProfile(parts[1]));
      return;
    }
    if (
      parts[0] === "profiles" &&
      parts.length === 2 &&
      parts[1] &&
      request.method === "PATCH"
    ) {
      const input = await body(request, [
        "expectedRevision",
        "approvalMode",
        "instructions",
        "defaultModelId",
        "tools",
      ]);
      if (
        input.tools !== undefined &&
        (!Array.isArray(input.tools) ||
          input.tools.some((tool) => typeof tool !== "string"))
      )
        throw new RuntimeError("invalid", "Expected tool list");
      if ("approvalMode" in input && !isApprovalMode(input.approvalMode))
        throw new RuntimeError("invalid", "Invalid approval mode");
      json(
        response,
        200,
        options.runtime.updateProfile(parts[1], {
          expectedRevision: string(input.expectedRevision),
          ...(isApprovalMode(input.approvalMode)
            ? { approvalMode: input.approvalMode }
            : {}),
          ...(input.instructions !== undefined
            ? { instructions: string(input.instructions) }
            : {}),
          ...(input.defaultModelId !== undefined
            ? { defaultModelId: string(input.defaultModelId) }
            : {}),
          ...(input.tools !== undefined
            ? { tools: input.tools as string[] }
            : {}),
        }),
      );
      return;
    }
    if (
      parts[0] === "profiles" &&
      parts.length === 2 &&
      parts[1] &&
      request.method === "DELETE"
    ) {
      const input = await body(request, ["expectedRevision"]);
      options.runtime.deleteProfile(parts[1], string(input.expectedRevision));
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (parts[0] === "threads") {
      if (parts.length === 1) {
        if (request.method === "POST") {
          const input = await body(request, ["profileId", "idempotencyKey"]);
          operatorCreationKey(input.idempotencyKey);
          json(
            response,
            201,
            publicThread(
              options.runtime.createThread({
                profileId: string(input.profileId),
                ...(input.idempotencyKey === undefined
                  ? {}
                  : { idempotencyKey: string(input.idempotencyKey) }),
              }),
            ),
          );
          return;
        }
      }
      const id = parts[1];
      if (id && parts.length === 2 && request.method === "GET") {
        json(response, 200, publicThread(options.runtime.getThread(id)));
        return;
      }
      if (
        id &&
        parts.length === 3 &&
        parts[2] === "owner" &&
        request.method === "POST"
      ) {
        const input = await body(request, [
          "expectedRevision",
          "confirmStopped",
          "reason",
        ]);
        reconcileThreadOwnership(options);
        json(
          response,
          200,
          publicThread(
            options.runtime.claimOperatorThread(id, {
              expectedRevision: string(input.expectedRevision),
              confirmStopped: input.confirmStopped === true,
              reason: string(input.reason),
            }),
          ),
        );
        return;
      }
      if (id && parts.length === 3 && parts[2] === "branches") {
        if (request.method === "GET") {
          json(response, 200, await options.runtime.branchPoints(id));
          return;
        }
        if (request.method === "POST") {
          const input = await body(request, [
            "entryId",
            "idempotencyKey",
            "replyToRunId",
            "replyToRole",
          ]);
          requireOperator(options.runtime.getThread(id));
          operatorCreationKey(input.idempotencyKey);
          json(
            response,
            201,
            publicThread(
              await options.runtime.forkThread({
                threadId: id,
                entryId: string(input.entryId),
                ...(input.replyToRunId === undefined
                  ? {}
                  : { replyToRunId: string(input.replyToRunId) }),
                ...(input.replyToRole === undefined
                  ? {}
                  : {
                      replyToRole: string(input.replyToRole) as
                        "user" | "assistant",
                    }),
                ...(input.idempotencyKey === undefined
                  ? {}
                  : { idempotencyKey: string(input.idempotencyKey) }),
              }),
            ),
          );
          return;
        }
      }
      if (
        id &&
        parts.length === 3 &&
        parts[2] === "summary" &&
        request.method === "GET"
      ) {
        if (url.search)
          throw new RuntimeError("invalid", "Invalid thread summary query");
        json(response, 200, options.runtime.threadSummary(id));
        return;
      }
      if (
        id &&
        parts.length === 3 &&
        parts[2] === "forks" &&
        request.method === "GET"
      ) {
        for (const key of url.searchParams.keys())
          if (
            !["after", "limit"].includes(key) ||
            url.searchParams.getAll(key).length !== 1
          )
            throw new RuntimeError("invalid", "Invalid fork page query");
        const after = url.searchParams.get("after"),
          limit = url.searchParams.get("limit");
        const page = options.runtime.listForkOperations(id, {
          ...(after === null ? {} : { after }),
          ...(limit === null ? {} : { limit: Number(limit) }),
        });
        json(response, 200, {
          ...page,
          items: page.items.map((op) => ({
            ...op,
            ...(op.state === "completed"
              ? {
                  childSummary: options.runtime.threadSummary(op.childThreadId),
                }
              : {}),
          })),
        });
        return;
      }
      if (id && parts.length === 3 && parts[2] === "runs") {
        if (request.method === "POST") {
          const input = await body(request, [
            "text",
            "idempotencyKey",
            "modelId",
            "attachmentIds",
          ]);
          requireOperator(options.runtime.getThread(id));
          const run = options.runtime.startTurn({
            threadId: id,
            text:
              typeof input.text === "string" ? input.text : string(input.text),
            ...(input.attachmentIds !== undefined
              ? { attachmentIds: input.attachmentIds as string[] }
              : {}),
            idempotencyKey: string(input.idempotencyKey),
            ...(input.modelId !== undefined
              ? { modelId: string(input.modelId) }
              : {}),
          });
          json(response, 202, run);
          return;
        }
      }
    }
    if (parts[0] === "forks" && parts[1]) {
      const id = parts[1];
      if (parts.length === 2 && request.method === "GET") {
        json(response, 200, options.runtime.getForkOperation(id));
        return;
      }
      if (
        parts.length === 3 &&
        parts[2] === "ownership" &&
        request.method === "GET"
      ) {
        json(response, 200, options.runtime.inspectForkOwnership(id));
        return;
      }
      if (
        parts.length === 3 &&
        parts[2] === "reconcile" &&
        request.method === "POST"
      ) {
        const input = await body(request, ["reason", "confirmStopped"]);
        json(
          response,
          200,
          options.runtime.reconcileFork(
            id,
            input as unknown as Parameters<AgentRuntime["reconcileFork"]>[1],
          ),
        );
        return;
      }
    }
    if (parts[0] === "runs" && parts[1]) {
      const id = parts[1];
      if (
        parts.length === 3 &&
        parts[2] === "ownership" &&
        request.method === "GET"
      ) {
        json(response, 200, options.runtime.inspectRunOwnership(id));
        return;
      }
      if (
        parts.length === 3 &&
        parts[2] === "reconcile" &&
        request.method === "POST"
      ) {
        const input = await body(request, ["reason", "confirmStopped"]);
        json(
          response,
          200,
          options.runtime.reconcileRun(
            id,
            input as unknown as Parameters<AgentRuntime["reconcileRun"]>[1],
          ),
        );
        return;
      }

      if (
        parts.length === 3 &&
        parts[2] === "interactions" &&
        request.method === "GET"
      ) {
        json(response, 200, options.runtime.listInteractions(id));
        return;
      }
      if (
        parts.length === 5 &&
        parts[2] === "interactions" &&
        parts[3] &&
        parts[4] === "respond" &&
        request.method === "POST"
      ) {
        const input = await body(request, ["response"]);
        json(
          response,
          200,
          options.runtime.respondInteraction(
            id,
            parts[3],
            input.response as InteractionResponse,
          ),
        );
        return;
      }
      if (parts.length === 2 && request.method === "GET") {
        json(response, 200, options.runtime.getRun(id));
        return;
      }
      if (
        parts.length === 3 &&
        parts[2] === "cancel" &&
        request.method === "POST"
      ) {
        await body(request, []);
        json(response, 202, options.runtime.cancelRun(id));
        return;
      }
      if (
        parts.length === 3 &&
        parts[2] === "events" &&
        request.method === "GET"
      ) {
        const raw =
          url.searchParams.get("after") ??
          request.headers["last-event-id"] ??
          "0";
        if (typeof raw !== "string" || !/^\d+$/.test(raw))
          throw new RuntimeError("invalid", "Invalid event cursor");
        let cursor = Number(raw);
        options.runtime.events(id, cursor);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        });
        response.flushHeaders();
        let paused = false;
        const pump = () => {
          if (response.destroyed || paused) return;
          try {
            const events = options.runtime.events(id, cursor);
            for (const event of events) {
              cursor = event.sequence;
              if (
                !response.write(
                  `id: ${event.sequence}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`,
                )
              ) {
                paused = true;
                response.once("drain", () => {
                  paused = false;
                  pump();
                });
                return;
              }
            }
            if (
              events.length < 1000 &&
              options.runtime.getRun(id).state !== "running"
            )
              response.end();
          } catch {
            response.destroy();
          }
        };
        const timer = setInterval(pump, 50);
        response.once("close", () => clearInterval(timer));
        pump();
        return;
      }
    }
    json(response, 404, { error: "not_found" });
  }
  const server = createServer((request, response) => {
    void route(request, response).catch((error) => {
      const code =
        error instanceof RuntimeError ||
        error instanceof TaskError ||
        error instanceof RoutineError ||
        error instanceof MessagingError ||
        error instanceof ArtifactError ||
        error instanceof DesktopError
          ? error.code
          : "internal";
      const statuses: Record<string, number> = {
        invalid: 400,
        not_found: 404,
        conflict: 409,
        unavailable: 503,
        closed: 503,
        timeout: 504,
      };
      if (!response.headersSent)
        json(response, statuses[code] ?? 500, { error: code });
      else response.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 65005, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const viewer = options.desktops
    ? attachDesktopViewer({ server, desktops: options.desktops, authenticate })
    : undefined;
  return {
    address: (server.address() as AddressInfo).address,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      await viewer?.close();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function requireOperator(thread: Thread): void {
  if (thread.owner?.kind !== "operator")
    throw new RuntimeError(
      "conflict",
      "Thread is domain-owned or requires ownership reconciliation; use its task or channel workflow",
    );
}

function operatorCreationKey(value: unknown): void {
  if (
    typeof value === "string" &&
    /^(messaging:|channel-fork:|voice:)/.test(value)
  )
    throw new RuntimeError(
      "invalid",
      "Idempotency namespace is reserved for domain workflows",
    );
}
