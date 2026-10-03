import { GitHubPushes } from "./github-pushes.js";
import {
  readPackagedBuildInfo,
  parseBuildInfo,
  type BackendBuildInfo,
} from "./build-info.js";
import { ConversationOutputDownloads } from "./conversation-output-downloads.js";
import { ConnectorService } from "./connectors/service.js";
import { ConnectorStore } from "./connectors/store.js";
import {
  parseConnectorConfig,
  loadConnectorCredentials,
} from "./connectors/config.js";
import { stageConnectorFile } from "./connectors/files.js";
import { ConversationOutputStore } from "./conversation-output-store.js";
import { ConversationOutputExports } from "./conversation-output-exports.js";
import type { ConversationOutputScope } from "@mindi/agent-runtime";
interface ConversationExports {
  prepare(scope: ConversationOutputScope): string | Promise<string>;
  capture(
    scope: ConversationOutputScope,
    parts: readonly string[],
  ): Promise<Buffer>;
  close(): Promise<void>;
}
import { TaskDiscussionPublisher } from "./task-discussions.js";
import { TaskOutputStore } from "./task-output-store.js";
import { TaskOutputExports } from "./task-output-exports.js";
import { TaskOutputDownloads } from "./task-output-downloads.js";
import type { TaskOutputScope } from "@mindi/agent-runtime/task-outputs";
interface OutputExports {
  prepare(scope: TaskOutputScope): string | Promise<string>;
  capture(scope: TaskOutputScope, parts: readonly string[]): Promise<Buffer>;
  close(): Promise<void>;
}
import {
  loadRoutineDeliveryAdapters,
  parseRoutineDeliveryConfig,
} from "./routine-delivery-config.js";
import { AttachmentStore } from "./attachments.js";
import { routineDestinationChoices } from "./routine-destinations.js";
import {
  PiCoordinatorWorker,
  type PiCoordinatorOptions,
} from "@mindi/coordinator";
import { routeCoordinator } from "./coordinator-routing.js";
import { coordinatorHistory } from "./coordinator-history.js";
import { CoordinatorUpdates } from "./coordinator-updates.js";
import { VoiceService } from "./voice-service.js";
import { OpenAiLiveProvider, type LiveProvider } from "./voice-provider.js";
import { DelegationService } from "./delegation-service.js";
import { fileURLToPath } from "node:url";
import { ownedServiceSource, StatusProjection } from "./status-projection.js";
import { SystemSampler } from "./system-stats.js";
import { ArtifactStore } from "./artifacts.js";
import {
  acquireDesktopOwnership,
  startDesktopService,
  startDesktopToolServer,
  type DesktopToolServer,
  type DesktopService,
  type DesktopServiceOptions,
} from "@mindi/desktop";
import { TaskDispatcher, TaskRunner } from "@mindi/task-runner";
import { TaskError, TaskStore } from "@mindi/tasks";
import { MessagingStore } from "@mindi/messaging";
import { MessageRunner } from "@mindi/message-runner";
import {
  RoutineError,
  RoutineStore,
  RoutineScheduler,
  RoutinePublisher,
  RoutineDeliveryPublisher,
  RoutineDeliveryRegistry,
  type RoutineDeliveryAdapter,
} from "@mindi/routines";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentRuntime,
  RuntimeError,
  type AgentWorker,
} from "@mindi/agent-runtime";
import { OmpWorker } from "@mindi/omp";
import { startAgentToolServer, type AgentToolServer } from "@mindi/agent-tools";
import { validateCoordinator, type BackendConfig } from "./config.js";
import { startBackend } from "./http.js";
/** Preserve close ordering while ensuring one failure cannot strand later loops. */
async function closeOwnedServices(closers: Array<() => Promise<void> | void>) {
  const failures: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
}
export async function startApplication(options: {
  config: BackendConfig;
  /** Explicit embedding seam; normal startup reads the fixed package metadata file. */
  buildInfo?: BackendBuildInfo | null;
  liveProvider?: LiveProvider;
  openAiApiKey?: string;
  token: string;
  worker?: AgentWorker;
  routineDeliveryAdapters?: () => readonly RoutineDeliveryAdapter[];
  connectorPeers?: Pick<
    ConstructorParameters<typeof ConnectorService>[0],
    "request" | "socketFactory"
  >;
  conversationOutputExports?: (
    options: ConstructorParameters<typeof ConversationOutputExports>[0],
  ) => ConversationExports;
  coordinator?: Pick<PiCoordinatorOptions, "streamFn" | "resolveModel">;
  desktop?: Pick<DesktopServiceOptions, "launch" | "connect">;
  /** Fixture seam; production uses Linux descriptor-relative export capture. */
  outputExports?: (
    options: ConstructorParameters<
      typeof TaskOutputExports<TaskOutputScope>
    >[0],
  ) => OutputExports;
}) {
  const { config } = options;
  validateCoordinator(config);
  if (config.voice && !options.liveProvider && !options.openAiApiKey?.trim())
    throw new Error("Voice requires an OpenAI project API key");
  if (options.token.length < 32)
    throw new Error("Backend token must contain at least 32 characters");
  await mkdir(config.stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.workspace, { recursive: true });
  const releaseApplication = acquireDesktopOwnership(
    join(config.stateRoot, "application-ownership.sqlite"),
  );
  try {
    let agentTools: AgentToolServer | undefined;
    let desktopTools: DesktopToolServer | undefined;
    let attachments: AttachmentStore | undefined;
    let taskOutputs: TaskOutputStore | undefined;
    let outputExports: OutputExports | undefined;
    let conversationOutputs: ConversationOutputStore | undefined;
    let conversationExports: ConversationExports | undefined;
    const conversationCaptureEnabled =
      process.platform === "linux" ||
      options.conversationOutputExports !== undefined;
    const outputCaptureEnabled =
      process.platform === "linux" || options.outputExports !== undefined;
    const openAgentTools: NonNullable<
      PiCoordinatorOptions["openAgentTools"]
    > = ({ runId, profile, signal }) => {
      if (!agentTools) throw new Error("Task tools unavailable");
      return agentTools.open({
        runId,
        profileId: profile.id,
        tools: profile.tools ?? [],
        signal,
      });
    };
    const openDesktopTools: NonNullable<
      PiCoordinatorOptions["openDesktopTools"]
    > = ({ runId, profile, signal }) => {
      if (!desktopTools) throw new Error("Desktop tools unavailable");
      return desktopTools.open({
        runId,
        profileId: profile.id,
        tools: profile.tools ?? [],
        signal,
      });
    };
    const specialist =
      options.worker ??
      new OmpWorker({
        cwd: config.workspace,
        stateRoot: config.stateRoot,
        openAgentTools: ({ runId, profile, signal }) => {
          if (!agentTools) throw new Error("Task tools unavailable");
          return agentTools.open({
            runId,
            profileId: profile.id,
            tools: profile.tools ?? [],
            signal,
          });
        },
        openDesktopTools,
        ...(config.claude ? { claude: config.claude } : {}),
      });
    const coordinator = config.coordinator
      ? new PiCoordinatorWorker({
          stateRoot: config.stateRoot,
          openAgentTools,
          openDesktopTools,
          importLegacyHistory: (input) => coordinatorHistory(runtime, input),
          ...options.coordinator,
        })
      : undefined;
    const runtime: AgentRuntime = new AgentRuntime({
      ...(outputCaptureEnabled
        ? {
            taskOutputs: {
              async prepare(scope: TaskOutputScope, signal: AbortSignal) {
                signal.throwIfAborted();
                if (!outputExports) throw Error("Output exports unavailable");
                const path = await outputExports.prepare(scope);
                signal.throwIfAborted();
                return path;
              },
              async acquire(
                scope: TaskOutputScope,
                paths: readonly string[],
                signal: AbortSignal,
              ) {
                signal.throwIfAborted();
                if (!taskOutputs) throw Error("Output store unavailable");
                const outputs = await taskOutputs.acquire(scope, paths);
                signal.throwIfAborted();
                return outputs;
              },
            },
          }
        : {}),
      ...(conversationCaptureEnabled
        ? {
            conversationOutputs: {
              async prepare(
                scope: ConversationOutputScope,
                signal: AbortSignal,
              ) {
                signal.throwIfAborted();
                if (!conversationExports)
                  throw Error("Conversation exports unavailable");
                const path = await conversationExports.prepare(scope);
                signal.throwIfAborted();
                return path;
              },
              async acquire(
                scope: ConversationOutputScope,
                paths: readonly string[],
                signal: AbortSignal,
              ) {
                signal.throwIfAborted();
                if (!conversationOutputs)
                  throw Error("Conversation output store unavailable");
                const files = await conversationOutputs.acquire(scope, paths);
                signal.throwIfAborted();
                return files;
              },
            },
          }
        : {}),
      resolveAttachments: (thread, ids) => {
        if (!attachments)
          throw new RuntimeError("unavailable", "Attachment store unavailable");
        return attachments.resolve(thread, ids);
      },
      databasePath: join(config.stateRoot, "backend.sqlite"),
      profiles: config.profiles,
      worker: coordinator
        ? routeCoordinator(
            config.coordinator!.profileId,
            coordinator,
            specialist,
          )
        : specialist,
    });
    const delegations = new DelegationService({
      runtime,
      transcriptDir: join(config.stateRoot, "transcripts"),
      ...(config.herdr
        ? {
            herdr: {
              root: config.herdr.runtimeRoot,
              cwd: config.workspace,
              launcher: { command: config.herdr.command },
              viewer: {
                command: process.execPath,
                args: [
                  fileURLToPath(import.meta.resolve("@mindi/herdr/viewer")),
                ],
              },
            },
          }
        : {}),
    });
    let voice: VoiceService | undefined;
    let artifacts: ArtifactStore | undefined;
    let desktops: DesktopService | undefined;
    let tasks: TaskStore | undefined;
    let taskDiscussionPublisher: TaskDiscussionPublisher | undefined;
    let runner: TaskRunner | undefined;
    let dispatcher: TaskDispatcher | undefined;
    let routines: RoutineStore | undefined;
    let routineScheduler: RoutineScheduler | undefined;
    let routinePublisher: RoutinePublisher | undefined;
    let routineDeliveryPublisher: RoutineDeliveryPublisher | undefined;
    let messaging: MessagingStore | undefined;
    let messageRunner: MessageRunner | undefined;
    let connectorStore: ConnectorStore | undefined;
    let connectors: ConnectorService | undefined;
    let coordinatorUpdates: CoordinatorUpdates | undefined;
    let githubPushes: GitHubPushes | undefined;
    try {
      githubPushes = await GitHubPushes.open(
        join(config.stateRoot, "github-pushes.sqlite"),
        config.githubPush,
      );
      const deliveryConfiguration = parseRoutineDeliveryConfig(
        config.routineDeliveries ?? [],
        config.stateRoot,
      );
      for (const binding of deliveryConfiguration) {
        if (binding.profileIds.some((id) => !runtime.hasProfileIdentity(id)))
          throw new Error("Unknown routine delivery profile");
      }
      const configuredDeliveryAdapters = options.routineDeliveryAdapters
        ? []
        : await loadRoutineDeliveryAdapters(
            deliveryConfiguration,
            config.stateRoot,
            runtime.listProfiles().map((profile) => profile.id),
          );
      if (config.voice) {
        voice = new VoiceService({
          runtime,
          databasePath: join(config.stateRoot, "voice.sqlite"),
          profileId: config.voice.profileId,
          provider:
            options.liveProvider ??
            new OpenAiLiveProvider(options.openAiApiKey!),
        });
        await voice.recover();
      }
      artifacts = new ArtifactStore({
        databasePath: join(config.stateRoot, "artifacts.sqlite"),
        workspace: config.workspace,
        validateProfile: (id) => {
          runtime.getProfile(id);
        },
      });
      desktops = await startDesktopService({
        stateRoot: config.stateRoot,
        listProfiles: () => runtime.listProfiles(),
        validateProfile: (id) => {
          runtime.getProfile(id);
        },
        ...options.desktop,
      });
      desktopTools = await startDesktopToolServer({ desktops });
      messaging = new MessagingStore({
        forwardAgentAttachments: (input) => {
          if (!attachments)
            throw new RuntimeError(
              "unavailable",
              "Attachment store unavailable",
            );
          return attachments.forward(input);
        },
        resolveExternalAttachments: (scope, provenance, ids) => {
          if (!attachments)
            throw new RuntimeError(
              "unavailable",
              "Attachment store unavailable",
            );
          return attachments.resolveExternal(scope, provenance, ids);
        },
        databasePath: join(config.stateRoot, "messaging.sqlite"),
        resolveAttachments: (scope, ids) => {
          if (!attachments)
            throw new RuntimeError(
              "unavailable",
              "Attachment store unavailable",
            );
          return ids.map((id) => {
            const metadata = attachments!.get(id);
            if (
              metadata.scope.kind !== "channel" ||
              metadata.scope.channelId !== scope.channelId ||
              metadata.scope.profileId !== scope.profileId ||
              (metadata.scope.branchId ?? null) !== (scope.branchId ?? null)
            )
              throw new RuntimeError(
                "conflict",
                "Attachment channel scope mismatch",
              );
            return { ...metadata, scope: metadata.scope };
          });
        },

        profileAvailable: (id) => {
          try {
            runtime.getProfile(id);
            return true;
          } catch (error) {
            if (error instanceof RuntimeError && error.code === "not_found")
              return false;
            throw error;
          }
        },
      });
      attachments = new AttachmentStore({
        databasePath: join(config.stateRoot, "attachments.sqlite"),
        runtime,
        messaging: () => messaging,
      });
      messageRunner = new MessageRunner({
        runtime,
        messaging,
        authorizeExternalMessage: (message) =>
          connectors?.authorized(message) ?? false,
        externalMessageReady: (message) => connectors?.ready(message) ?? false,
      });
      tasks = new TaskStore({
        databasePath: join(config.stateRoot, "tasks.sqlite"),
        validateMessagingChannel: (id) => {
          if (messaging!.getChannel(id).kind !== "channel")
            throw new TaskError(
              "invalid",
              "Board requires a shared messaging channel",
            );
        },
        validateDiscussionChannel: (id) => {
          const channel = messaging!.getChannel(id);
          if (
            channel.kind !== "channel" ||
            !channel.members.includes("operator")
          )
            throw new TaskError(
              "conflict",
              "Task discussion requires an operator-accessible channel",
            );
        },
        validateAssignee: (id) => {
          runtime.getProfile(id);
        },
      });
      taskDiscussionPublisher = new TaskDiscussionPublisher({
        tasks,
        messaging,
      });
      const validateOutputScope = (scope: TaskOutputScope) => {
        runtime.getProfile(scope.profileId);
        const attempt = tasks!.getAttempt(scope.attemptId);
        const thread = runtime.getThread(scope.threadId);
        const run = runtime.getRun(scope.runId);
        if (
          attempt.taskId !== scope.taskId ||
          attempt.threadId !== scope.threadId ||
          attempt.runId !== scope.runId ||
          attempt.snapshot.assignee !== scope.profileId ||
          thread.profileId !== scope.profileId ||
          thread.owner?.kind !== "task" ||
          thread.owner.id !== scope.taskId ||
          run.threadId !== scope.threadId ||
          run.task?.taskId !== scope.taskId ||
          run.task.attemptId !== scope.attemptId
        )
          throw Error("Output native ownership mismatch");
      };
      if (outputCaptureEnabled)
        outputExports = (
          options.outputExports ?? ((options) => new TaskOutputExports(options))
        )({
          databasePath: join(config.stateRoot, "output-exports.sqlite"),
          exportRoot: join(config.stateRoot, "output-exports"),
          validateScope: (scope) => {
            validateOutputScope(scope);
            if (runtime.getRun(scope.runId).state !== "running")
              throw Error("Output capture requires active run");
          },
        });
      taskOutputs = new TaskOutputStore({
        databasePath: join(config.stateRoot, "task-outputs.sqlite"),
        validateScope: validateOutputScope,
        capture: (scope, parts) => {
          if (!outputExports) throw Error("Output capture requires Linux");
          return outputExports.capture(scope, parts);
        },
      });
      const validateConversationOutputScope = (
        scope: ConversationOutputScope,
      ) => {
        runtime.getProfile(scope.profileId);
        const thread = runtime.getThread(scope.threadId),
          run = runtime.getRun(scope.runId);
        const mapping = messaging!.getConversation(
          scope.channelId,
          scope.profileId,
          scope.branchId,
        );
        if (
          thread.profileId !== scope.profileId ||
          thread.owner?.kind !== "channel" ||
          thread.owner.id !== scope.channelId ||
          run.threadId !== scope.threadId ||
          run.conversation?.channelId !== scope.channelId ||
          (run.conversation?.branchId ?? null) !== (scope.branchId ?? null) ||
          mapping?.threadId !== scope.threadId
        )
          throw Error("Conversation output native ownership mismatch");
      };
      if (conversationCaptureEnabled)
        conversationExports = (
          options.conversationOutputExports ??
          ((value) => new ConversationOutputExports(value))
        )({
          databasePath: join(
            config.stateRoot,
            "conversation-output-exports.sqlite",
          ),
          exportRoot: join(config.stateRoot, "conversation-output-exports"),
          validateScope: (scope) => {
            validateConversationOutputScope(scope);
            if (runtime.getRun(scope.runId).state !== "running")
              throw Error("Conversation capture requires active run");
          },
        });
      conversationOutputs = new ConversationOutputStore({
        databasePath: join(config.stateRoot, "conversation-outputs.sqlite"),
        validateScope: validateConversationOutputScope,
        capture: (scope, parts) => {
          if (!conversationExports)
            throw Error("Conversation capture requires Linux");
          return conversationExports.capture(scope, parts);
        },
      });
      const connectorConfiguration = parseConnectorConfig(
        config.connectors,
        config.stateRoot,
        runtime.listProfiles().map((profile) => profile.id),
      );
      const connectorCredentials = await loadConnectorCredentials(
        connectorConfiguration,
        config.stateRoot,
      );
      connectorStore = new ConnectorStore({
        databasePath: join(config.stateRoot, "connectors.sqlite"),
      });
      connectors = new ConnectorService({
        stateRoot: config.stateRoot,
        store: connectorStore,
        messaging,
        config: connectorConfiguration,
        credentials: connectorCredentials,
        ...options.connectorPeers,
        admitFile: (binding, event, file) =>
          stageConnectorFile({
            attachments: attachments!,
            messaging: messaging!,
            store: connectorStore!,
            binding,
            event,
            file,
          }),
        admitFiles: (reply, delivery) => {
          const run = runtime.getRun(delivery.runId!);
          if (
            JSON.stringify(run.conversationOutputs ?? []) !==
            JSON.stringify(reply.conversationOutputs ?? [])
          )
            throw Error("Conversation output receipt mismatch");
          return (reply.conversationOutputs ?? []).map((file) => {
            const saved = conversationOutputs!.content(file.scope, file.id);
            if (JSON.stringify(saved.metadata) !== JSON.stringify(file))
              throw Error("Conversation output changed");
            return {
              id: file.id,
              name: file.name,
              mediaType: file.mediaType,
              size: file.size,
              sha256: file.sha256,
            };
          });
        },
        readFile: async (file, reply) => {
          const run = runtime.getRun(reply.runId),
            nativeFile = run.conversationOutputs?.find(
              (value) => value.id === file.id,
            );
          if (
            !nativeFile ||
            nativeFile.scope.channelId !== reply.binding.channelId ||
            nativeFile.scope.profileId !== reply.binding.profileId ||
            nativeFile.scope.branchId
          )
            throw Error("Conversation file scope mismatch");
          const saved = conversationOutputs!.content(nativeFile.scope, file.id);
          return {
            metadata: {
              id: saved.metadata.id,
              name: saved.metadata.name,
              mediaType: saved.metadata.mediaType,
              size: saved.metadata.size,
              sha256: saved.metadata.sha256,
            },
            bytes: saved.bytes,
          };
        },
      });
      runner = new TaskRunner({ runtime, tasks });
      if (config.coordinator)
        coordinatorUpdates = new CoordinatorUpdates({
          databasePath: join(config.stateRoot, "coordinator-updates.sqlite"),
          messaging,
          runtime,
          tasks,
          profileId: config.coordinator.profileId,
          onRun: (runId) => {
            void voice?.observeCoordinatorUpdate(runId).catch(() => {});
          },
        });
      agentTools = await startAgentToolServer({
        tasks,
        messaging,
        onResult: (event) => coordinatorUpdates?.watch(event),
        onBeforeTaskAction: (event) =>
          coordinatorUpdates?.beforeTaskAction(event),
      });
      dispatcher = new TaskDispatcher({ tasks, runner });
      const deliveryAdapters = () => {
        const active = new Set(
          runtime.listProfiles().map((profile) => profile.id),
        );
        return (
          options.routineDeliveryAdapters?.() ?? configuredDeliveryAdapters
        )
          .map((adapter) => ({
            ...adapter,
            profileIds: adapter.profileIds.filter((id) => active.has(id)),
          }))
          .filter((adapter) => adapter.profileIds.length > 0);
      };
      const deliveryBindings = () =>
        deliveryAdapters().map(
          ({
            id,
            revision,
            platform,
            profileIds,
            home,
            resolve,
            normalizeOrigin,
          }) => ({
            id,
            revision,
            platform,
            profileIds,
            home,
            resolve,
            normalizeOrigin,
          }),
        );
      routines = new RoutineStore({
        resolveTaskOutputs: (occurrence) => {
          const attempt = tasks!.getAttempt(occurrence.attemptId!);
          if (
            attempt.taskId !== occurrence.taskId ||
            attempt.snapshot.routineOccurrenceId !== occurrence.id ||
            !attempt.runId ||
            !attempt.threadId ||
            !attempt.snapshot.assignee
          )
            throw new RoutineError(
              "invalid",
              "Routine output evidence unavailable",
            );
          if (attempt.outputs === undefined) return undefined;
          return {
            scope: {
              profileId: attempt.snapshot.assignee,
              threadId: attempt.threadId,
              runId: attempt.runId,
              taskId: attempt.taskId,
              attemptId: attempt.id,
            },
            outputs: attempt.outputs,
          };
        },
        resolveDelivery: (routine) =>
          new RoutineDeliveryRegistry(deliveryBindings()).resolve(
            routine.profileId,
            routine.deliver!,
          ),
        databasePath: join(config.stateRoot, "routines.sqlite"),
        validateDestination: (profileId, destination) => {
          runtime.getProfile(profileId);
          const channel = messaging!.getChannel(destination.channelId);
          if (!channel.members.includes(`agent:${profileId}`))
            throw new RoutineError(
              "invalid",
              "Routine persona must be a destination member",
            );
          if (
            destination.branchId &&
            messaging!.getBranch(destination.branchId).channelId !== channel.id
          )
            throw new RoutineError(
              "invalid",
              "Routine branch must belong to destination channel",
            );
        },
        validateTarget: (profileId, boardId) => {
          runtime.getProfile(profileId);
          if (tasks!.getBoard(boardId).archived)
            throw new RoutineError("conflict", "Routine board is archived");
        },
      });
      routineScheduler = new RoutineScheduler({ routines, tasks, runner });
      routinePublisher = new RoutinePublisher({ routines, tasks, messaging });
      routineDeliveryPublisher = new RoutineDeliveryPublisher({
        routines,
        adapters: deliveryAdapters,
        resolveOutput: async (delivery, id) => {
          const occurrence = routines!.getOccurrence(delivery.occurrenceId);
          if (
            !occurrence.attemptId ||
            occurrence.routineId !== delivery.routineId ||
            occurrence.snapshot.profileId !== delivery.profileId ||
            occurrence.state !== delivery.outcome ||
            occurrence.summary !== delivery.summary ||
            JSON.stringify(occurrence.outputs) !==
              JSON.stringify(delivery.outputs)
          )
            throw Error("Delivery output ownership mismatch");
          const attempt = tasks!.getAttempt(occurrence.attemptId);
          if (
            attempt.taskId !== occurrence.taskId ||
            attempt.snapshot.routineOccurrenceId !== occurrence.id ||
            attempt.state !== occurrence.state ||
            attempt.summary !== occurrence.summary ||
            JSON.stringify(attempt.outputs) !==
              JSON.stringify(occurrence.outputs) ||
            !attempt.outputs?.length
          )
            throw Error("Delivery native output mismatch");
          return taskOutputs!.content(attempt.outputs[0]!.scope, id);
        },
      });
      const server = await startBackend({
        githubPushes,
        taskOutputDownloads: new TaskOutputDownloads({
          messaging,
          tasks,
          routines,
          outputs: taskOutputs,
          profileAvailable: (id) =>
            runtime.listProfiles().some((profile) => profile.id === id),
        }),
        routineDestinations: () =>
          routineDestinationChoices(
            deliveryBindings(),
            runtime.listProfiles().map((profile) => profile.id),
            new Map(
              deliveryConfiguration.map((binding) => [
                binding.id,
                Object.keys(binding.aliases ?? {}),
              ]),
            ),
          ),
        coordinatorUpdates,
        voice,
        delegations,
        status: new StatusProjection({
          runtime,
          build:
            options.buildInfo === undefined
              ? await readPackagedBuildInfo()
              : options.buildInfo === null
                ? null
                : parseBuildInfo(options.buildInfo),
          stateRoot: config.stateRoot,
          sampler: new SystemSampler({ workspace: config.workspace }),
          components: [
            ...(coordinatorUpdates
              ? [ownedServiceSource("coordinatorUpdates", coordinatorUpdates)]
              : []),
            ownedServiceSource("dispatcher", dispatcher),
            ownedServiceSource("messaging", messageRunner),
            ownedServiceSource("routines", routineScheduler),
            ownedServiceSource("routinePublisher", routinePublisher),
            ownedServiceSource("taskDiscussions", taskDiscussionPublisher),
            ownedServiceSource(
              "routineDeliveryPublisher",
              routineDeliveryPublisher,
            ),
            {
              id: "desktop",
              required: false,
              observe: () => ({
                state: "unknown" as const,
                detail: "Configured; readiness is not observed",
                observedAt: new Date().toISOString(),
              }),
            },
            {
              id: "hindsight",
              required: false,
              observe: () => ({
                state: config.profiles.some((p) => p.memory)
                  ? ("unknown" as const)
                  : ("unavailable" as const),
                detail: config.profiles.some((p) => p.memory)
                  ? "Configured; external access unverified"
                  : "Disabled",
                observedAt: new Date().toISOString(),
              }),
            },
            {
              id: "herdr",
              required: false,
              observe: () => delegations.herdrStatus(),
            },
          ],
        }),
        artifacts,
        attachments,
        desktops,
        messaging,
        messageRunner,
        runtime,
        tasks,
        runner,
        dispatcher,
        routines,
        routineScheduler,
        routinePublisher,
        taskDiscussionPublisher,
        routineDeliveryPublisher,
        connectors,
        conversationOutputDownloads: new ConversationOutputDownloads({
          runtime,
          messaging,
          outputs: conversationOutputs,
        }),
        token: options.token,
        port: config.port,
        host: config.host,
      });
      coordinatorUpdates?.start();
      dispatcher.start();
      routineScheduler.start();
      routinePublisher.start();
      taskDiscussionPublisher.start();
      routineDeliveryPublisher.start();
      connectors.start();
      messageRunner.start();
      let shutdown: Promise<void> | undefined;
      return {
        url: server.url,
        close: () => {
          shutdown ??= (async () => {
            try {
              try {
                await closeOwnedServices([
                  () => coordinatorUpdates?.close(),
                  () => connectors?.close(),
                  () => routineDeliveryPublisher?.close(),
                  () => messageRunner?.close(),
                  () => routineScheduler?.close(),
                  () => routinePublisher?.close(),
                  () => taskDiscussionPublisher?.close(),
                  () => dispatcher?.close(),
                  () => server.close(),
                  () => voice?.close(),
                ]);
              } finally {
                try {
                  try {
                    await runner?.close();
                  } finally {
                    await runtime.close();
                    await messageRunner?.branches.drain();
                  }
                } finally {
                  try {
                    await agentTools?.close();
                  } finally {
                    try {
                      try {
                        await desktopTools?.close();
                      } finally {
                        await desktops?.close();
                      }
                    } finally {
                      try {
                        await delegations.close();
                      } finally {
                        githubPushes?.close();
                      }
                      await artifacts?.close();
                      await taskOutputs?.close();
                      await outputExports?.close();
                      await conversationOutputs?.close();
                      await conversationExports?.close();
                      connectorStore?.close();
                      attachments?.close();
                      messaging?.close();
                      routines?.close();
                      tasks?.close();
                    }
                  }
                }
              }
            } finally {
              releaseApplication();
            }
          })();
          return shutdown;
        },
      };
    } catch (error) {
      try {
        try {
          await closeOwnedServices([
            () => coordinatorUpdates?.close(),
            () => connectors?.close(),
            () => routineDeliveryPublisher?.close(),
            () => messageRunner?.close(),
            () => routineScheduler?.close(),
            () => routinePublisher?.close(),
            () => taskDiscussionPublisher?.close(),
            () => dispatcher?.close(),
            () => runner?.close(),
            () => voice?.close(),
          ]);
        } finally {
          await runtime.close();
          await messageRunner?.branches.drain();
        }
      } finally {
        try {
          await agentTools?.close();
        } finally {
          try {
            try {
              await desktopTools?.close();
            } finally {
              await desktops?.close();
            }
          } finally {
            try {
              await delegations.close();
            } finally {
              githubPushes?.close();
            }
            await artifacts?.close();
            await taskOutputs?.close();
            await outputExports?.close();
            await conversationOutputs?.close();
            await conversationExports?.close();
            connectorStore?.close();
            attachments?.close();
            messaging?.close();
            routines?.close();
            tasks?.close();
          }
        }
      }
      throw error;
    }
  } catch (error) {
    releaseApplication();
    throw error;
  }
}
