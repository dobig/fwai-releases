import {
  CommandId,
  LinkChainId,
  LinkGroupId,
  MessageId,
  NodeId,
  PersonalAgentError,
  isAgentRequestOpen,
  personalAgentGrantFor,
  type AgentNeed,
  ThreadId,
  type AgentProposal,
  type AgentProposedAction,
  type AgentRequest,
  type ModelSelection,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type PersonalAgentAskInput,
  type PersonalAgentConfigureInput,
  type PersonalAgentPermissions,
  type PersonalAgentSetEnabledInput,
  type PersonalAgentState,
  ProjectId,
} from "@t3tools/contracts";
import type {
  RelayAgentColleague,
  RelayAgentDelivery,
  RelayAgentSyncResponse,
} from "@t3tools/contracts/relay";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ThreadShareService from "../threadShare/ThreadShareService.ts";
import {
  assignmentText,
  canEnforceReadOnlyTriage,
  confinesReadsToGrantedPaths,
  isRequestThreadId,
  requestIdOfThread,
  requestThreadId,
  requesterWakeText,
  triagePrompt,
  accessGrantedPrompt,
  workResultPrompt,
  workThreadId,
} from "./personalAgentPolicy.ts";
import * as PersonalAgentRelay from "./PersonalAgentRelay.ts";
import * as PersonalAgentScope from "./PersonalAgentScope.ts";
import * as PersonalAgentStore from "./PersonalAgentStore.ts";

/** Where the agent thread and its folder come from; the real one creates a managed project. */
export class PersonalAgentWorkspace extends Context.Service<
  PersonalAgentWorkspace,
  {
    /** Creates the agent's project and folder with its instructions and memory. */
    readonly createProject: Effect.Effect<
      { readonly projectId: ProjectId; readonly directory: string },
      PersonalAgentError
    >;
    readonly projectExists: (projectId: string) => Effect.Effect<boolean>;
  }
>()("t3/personalAgent/PersonalAgentService/PersonalAgentWorkspace") {}

/** One `PersonalAgentService` behind the RPCs, the MCP tools and the relay route (#22). */
export class PersonalAgentService extends Context.Service<
  PersonalAgentService,
  {
    readonly getState: Effect.Effect<PersonalAgentState>;
    readonly setEnabled: (
      input: PersonalAgentSetEnabledInput,
    ) => Effect.Effect<PersonalAgentState, PersonalAgentError>;
    readonly configure: (
      input: PersonalAgentConfigureInput,
    ) => Effect.Effect<PersonalAgentState, PersonalAgentError>;
    readonly setPermissions: (
      permissions: PersonalAgentPermissions,
    ) => Effect.Effect<PersonalAgentState, PersonalAgentError>;
    readonly ask: (input: PersonalAgentAskInput) => Effect.Effect<AgentRequest, PersonalAgentError>;
    /** Colleagues the owner can ask now, so an agent can turn a name into an account id. */
    readonly colleagues: (
      callerThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<RelayAgentColleague>, PersonalAgentError>;
    readonly isAgentThread: (threadId: string) => Effect.Effect<boolean>;
    /** A colleague request's isolated thread (#45): read-only, its own tools only. */
    readonly isRequestThread: (threadId: string) => boolean;
    /** Open requests for the agent thread to work on. */
    readonly inbox: (
      callerThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<AgentRequest>, PersonalAgentError>;
    /**
     * The request thread's proposal. Code decides it against the owner's grants (#45): auto runs
     * at once, ask fills the approval card, deny is refused.
     */
    readonly propose: (input: {
      readonly callerThreadId: ThreadId;
      readonly requestId: string;
      readonly proposal: Omit<AgentProposal, "proposedAt">;
    }) => Effect.Effect<ProposeOutcome, PersonalAgentError>;
    /** Threads the request's approved needs let it read. */
    readonly listThreads: (
      callerThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<PersonalAgentScope.ScopedThread>, PersonalAgentError>;
    readonly readThread: (
      callerThreadId: ThreadId,
      threadId: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>,
      PersonalAgentError
    >;
    /**
     * One of the same sender's earlier requests, listed for the caller's request by the relay;
     * any other id is refused, so a request thread never reads another colleague's history.
     */
    readonly readPriorRequest: (
      callerThreadId: ThreadId,
      requestId: string,
    ) => Effect.Effect<PriorRequestDetail, PersonalAgentError>;
    readonly receive: (delivery: RelayAgentDelivery) => Effect.Effect<void>;
    readonly sync: Effect.Effect<void>;
    /** Returns a dispatched action's result once its run ends. */
    readonly onRunUpdated: (threadId: ThreadId, run: OrchestrationV2Run) => Effect.Effect<void>;
  }
>()("t3/personalAgent/PersonalAgentService") {}

export interface PriorRequestDetail {
  readonly requestId: string;
  readonly createdAt: string;
  readonly status: string;
  readonly summary: string | null;
  readonly body: string;
  readonly context: string | null;
  readonly reply: string | null;
  readonly declineReason: string | null;
}

const AGENT_TASK_PREFIX = "agent:";
/** Scopes kept for request threads; older requests have long closed. */
const MAX_REQUEST_SCOPES = 100;
const THREAD_READ_MESSAGES = 30;
const THREAD_READ_MESSAGE_CHARS = 2_000;

export interface ProposeOutcome {
  /** `granted`: access given, a new message resumes the thread. `running`: approved by rules. */
  readonly outcome: "awaiting_owner" | "granted" | "running";
  readonly requestId: string;
}

/** Origins kept for replies to land in; older requests fall back to the agent thread. */
const MAX_ASK_ORIGINS = 100;
const AGENT_TITLE = "Personal agent";

const isTerminalRun = (run: Pick<OrchestrationV2Run, "status">) =>
  run.status === "completed" ||
  run.status === "failed" ||
  run.status === "interrupted" ||
  run.status === "cancelled" ||
  run.status === "rolled_back";

/** The request a dispatched run works for, from its link task's synthetic group id. */
const agentRequestIdOfRun = (run: Pick<OrchestrationV2Run, "linkTask">): string | null =>
  run.linkTask?.linkId.startsWith(AGENT_TASK_PREFIX) === true
    ? run.linkTask.linkId.slice(AGENT_TASK_PREFIX.length)
    : null;

const fail = (reason: PersonalAgentError["reason"], detail?: string) =>
  new PersonalAgentError({ reason, ...(detail === undefined ? {} : { detail }) });

/** A colleague as the environment can name them; clients show the username. */
const accountLabel = (accountId: string) => `a colleague (account ${accountId})`;

const make = Effect.gen(function* () {
  const store = yield* PersonalAgentStore.PersonalAgentStore;
  const relay = yield* PersonalAgentRelay.PersonalAgentRelay;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const workspace = yield* PersonalAgentWorkspace;
  const shares = yield* ThreadShareService.ThreadShareService;
  const lastSync = yield* Ref.make<RelayAgentSyncResponse | null>(null);
  const relayLinked = yield* Ref.make(false);
  const handling = yield* Semaphore.make(1);
  const crypto = yield* Crypto.Crypto;
  const scope = yield* PersonalAgentScope.PersonalAgentScope;

  const environmentId = environment.getEnvironmentId;

  const dispatch = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(Effect.asVoid);

  const threadTitle = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell?.title ?? null),
      Effect.orElseSucceed(() => null),
    );

  const getState = Effect.gen(function* () {
    const config = yield* store.get;
    const synced = yield* Ref.get(lastSync);
    return {
      enabled: config.enabled,
      relayLinked: yield* Ref.get(relayLinked),
      agentEnvironmentId: synced?.agent?.environmentId ?? null,
      threadId: config.threadId,
      projectId: config.projectId,
      providerInstanceId: config.providerInstanceId,
      modelSelection:
        config.threadId === null
          ? null
          : ((yield* orchestrator
              .getThreadShell(config.threadId)
              .pipe(Effect.orElseSucceed(() => null)))?.modelSelection ?? null),
      permissions: config.permissions,
      instructions: config.instructions,
    } satisfies PersonalAgentState;
  });

  const persist = (
    change: (
      config: PersonalAgentStore.PersonalAgentConfig,
    ) => PersonalAgentStore.PersonalAgentConfig,
  ) =>
    store.update(change).pipe(Effect.mapError(() => fail("failed", "Could not save the agent.")));

  /** A message in a thread that does not come from its user. */
  const notice = (input: {
    readonly key: string;
    readonly threadId: ThreadId;
    readonly text: string;
    readonly notification: OrchestrationV2Notification;
  }) =>
    dispatch({
      type: "message.dispatch",
      // Deterministic: the envelope and the sync may both see the same change.
      commandId: CommandId.make(`personal-agent:${input.key}`),
      messageId: MessageId.make(`personal-agent:${input.key}`),
      threadId: input.threadId,
      text: input.text,
      attachments: [],
      notification: input.notification,
      createdBy: "agent",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    });

  const ensureThread = Effect.fn("PersonalAgentService.ensureThread")(function* (
    modelSelection: ModelSelection | undefined,
  ) {
    let config = yield* store.get;
    if (config.projectId === null || !(yield* workspace.projectExists(config.projectId))) {
      const created = yield* workspace.createProject;
      config = yield* persist((current) => ({
        ...current,
        projectId: created.projectId,
        directory: created.directory,
        threadId: null,
      }));
    }
    const shell =
      config.threadId === null
        ? null
        : yield* orchestrator
            .getThreadShell(config.threadId)
            .pipe(Effect.orElseSucceed(() => null));
    if (shell !== null && shell.deletedAt === null && shell.archivedAt === null) {
      return config.threadId!;
    }
    if (modelSelection === undefined) {
      return yield* fail("invalid", "Choose the model the personal agent runs on.");
    }
    const threadId = ThreadId.make(
      `personal-agent-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
    );
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(`personal-agent:create:${threadId}`),
      threadId,
      projectId: config.projectId!,
      title: AGENT_TITLE,
      modelSelection,
      // The runtime policy holds every turn read-only regardless (PersonalAgentRuntimePolicy).
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "server",
    }).pipe(Effect.mapError(() => fail("failed", "Could not create the agent thread.")));
    yield* dispatch({
      type: "thread.auto-settle.set",
      commandId: CommandId.make(`personal-agent:no-settle:${threadId}`),
      threadId,
      enabled: false,
    }).pipe(Effect.ignore);
    yield* persist((current) => ({ ...current, threadId }));
    return threadId;
  });

  const setEnabled: PersonalAgentService["Service"]["setEnabled"] = Effect.fn(
    "PersonalAgentService.setEnabled",
  )(function* (input) {
    if (!input.enabled) {
      const response = yield* relay.setAgent({ enabled: false });
      if (response === null) return yield* fail("relay_unavailable");
      yield* persist((config) => ({ ...config, enabled: false }));
      yield* syncNow;
      return yield* getState;
    }
    const config = yield* store.get;
    const instanceId = input.modelSelection?.instanceId ?? config.providerInstanceId;
    const instance = instanceId === null ? undefined : yield* registry.getInstance(instanceId);
    if (instance === undefined) {
      return yield* fail("invalid", "Choose the model the personal agent runs on.");
    }
    if (!canEnforceReadOnlyTriage(instance.driverKind)) {
      return yield* fail("provider_not_read_only");
    }
    const threadId = yield* ensureThread(input.modelSelection);
    const response = yield* relay.setAgent({ enabled: true, threadId });
    if (response === null) return yield* fail("relay_unavailable");
    yield* persist((current) => ({
      ...current,
      enabled: response.agent?.environmentId !== undefined,
      providerInstanceId: instance.instanceId,
    }));
    yield* syncNow;
    return yield* getState;
  });

  /** The owner switches the agent's model or edits their instructions; both apply to the next turn. */
  const configure: PersonalAgentService["Service"]["configure"] = Effect.fn(
    "PersonalAgentService.configure",
  )(function* (input) {
    if (input.modelSelection !== undefined) {
      const instance = yield* registry.getInstance(input.modelSelection.instanceId);
      if (instance === undefined) return yield* fail("invalid", "That provider is not available.");
      if (!canEnforceReadOnlyTriage(instance.driverKind)) {
        return yield* fail("provider_not_read_only");
      }
      const config = yield* store.get;
      if (config.threadId !== null) {
        yield* dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(
            `personal-agent:model:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          ),
          threadId: config.threadId,
          modelSelection: input.modelSelection,
        }).pipe(Effect.mapError(() => fail("failed", "Could not switch the agent's model.")));
      }
      yield* persist((current) => ({ ...current, providerInstanceId: instance.instanceId }));
    }
    if (input.instructions !== undefined) {
      const instructions = input.instructions.trim();
      yield* persist((current) => ({ ...current, instructions }));
    }
    return yield* getState;
  });

  const setPermissions: PersonalAgentService["Service"]["setPermissions"] = Effect.fn(
    "PersonalAgentService.setPermissions",
  )(function* (permissions) {
    yield* persist((config) => ({ ...config, permissions }));
    return yield* getState;
  });

  const colleagues: PersonalAgentService["Service"]["colleagues"] = Effect.fn(
    "PersonalAgentService.colleagues",
  )(function* (callerThreadId) {
    if (isRequestThreadId(callerThreadId)) return yield* fail("not_permitted");
    const response = yield* relay.colleagues;
    if (response === null) return yield* fail("relay_unavailable");
    return response.colleagues;
  });

  /** An agent may name a colleague by username; the relay only takes account ids. */
  const resolveAccount = Effect.fn("PersonalAgentService.resolveAccount")(function* (to: string) {
    const known = (yield* relay.colleagues)?.colleagues ?? [];
    if (known.some((colleague) => colleague.accountId === to)) return to;
    const name = to.replace(/^@/u, "").toLowerCase();
    return known.find((colleague) => colleague.username?.toLowerCase() === name)?.accountId ?? to;
  });

  const ask: PersonalAgentService["Service"]["ask"] = Effect.fn("PersonalAgentService.ask")(
    function* (input) {
      if (isRequestThreadId(input.threadId)) {
        // A request instance forwards through its owner's decision, never by itself.
        return yield* fail("not_permitted", "Propose a forward instead; your user decides.");
      }
      // Asked outside any thread (a new window that never started): the asker's own agent
      // window sends it and receives the reply. Without one, the reply opens a thread later.
      const config = yield* store.get;
      const fromThreadId =
        (yield* liveShell(input.threadId)) === null &&
        config.threadId !== null &&
        (yield* liveShell(config.threadId)) !== null
          ? config.threadId
          : input.threadId;
      const response = yield* relay.create({
        toAccountId: yield* resolveAccount(input.toAccountId),
        body: input.body,
        ...(input.context === undefined ? {} : { context: input.context }),
        threadId: fromThreadId,
        threadTitle: (yield* threadTitle(fromThreadId)) ?? "",
      });
      if (response === null) return yield* fail("relay_unavailable");
      if (response.outcome !== "created" || response.request === undefined) {
        return yield* fail(response.outcome === "created" ? "failed" : response.outcome);
      }
      const origin = input.origin;
      if (origin !== undefined) {
        const requestId = response.request.id;
        yield* store
          .update((config) => ({
            ...config,
            askOrigins: [...config.askOrigins, { requestId, origin }].slice(-MAX_ASK_ORIGINS),
          }))
          .pipe(Effect.ignore);
      }
      return response.request;
    },
  );

  const isAgentThread = (threadId: string) =>
    store.get.pipe(
      Effect.map((config) => config.threadId !== null && config.threadId === threadId),
    );

  const requireAgentThread = Effect.fn("PersonalAgentService.requireAgentThread")(function* (
    callerThreadId: ThreadId,
  ) {
    const config = yield* store.get;
    if (config.threadId !== callerThreadId) {
      return yield* fail("not_permitted", "Only the personal agent thread can use this tool.");
    }
    if (!config.enabled) return yield* fail("not_enabled");
    return config;
  });

  /** Only a request's own thread proposes for it, so one colleague's instance never touches another's. */
  const requireRequestThread = Effect.fn("PersonalAgentService.requireRequestThread")(function* (
    callerThreadId: ThreadId,
    requestId: string,
  ) {
    const config = yield* store.get;
    if (requestIdOfThread(callerThreadId) !== requestId) {
      return yield* fail("not_permitted", "Only this request's own thread can propose for it.");
    }
    if (!config.enabled) return yield* fail("not_enabled");
    return config;
  });

  const inbox: PersonalAgentService["Service"]["inbox"] = Effect.fn("PersonalAgentService.inbox")(
    function* (callerThreadId) {
      yield* requireAgentThread(callerThreadId);
      const synced = yield* relay.sync;
      if (synced === null) return yield* fail("relay_unavailable");
      yield* Ref.set(lastSync, synced);
      return synced.inbox;
    },
  );

  /** The owner's grant for an action or need; send targets resolve to their project here. */
  const grantFor = Effect.fn("PersonalAgentService.grantFor")(function* (
    item: AgentProposedAction,
    config: PersonalAgentStore.PersonalAgentConfig,
  ) {
    const targetProject =
      item.kind === "send_to_thread" ? yield* scope.projectOfThread(item.threadId) : null;
    return personalAgentGrantFor(config.permissions, item, () => targetProject);
  });

  const approvedNeeds = (config: PersonalAgentStore.PersonalAgentConfig, requestId: string) =>
    config.requestScopes.find((entry) => entry.requestId === requestId)?.needs ?? [];

  /** Records access for a request's thread and resumes it; the next turn runs with that scope. */
  const grantAccess = Effect.fn("PersonalAgentService.grantAccess")(function* (
    requestId: string,
    needs: ReadonlyArray<AgentNeed>,
    approvedBy: "rules" | "owner",
  ) {
    yield* persist((config) => {
      const merged = [...approvedNeeds(config, requestId), ...needs];
      const unique = merged.filter(
        (need, index) =>
          merged.findIndex(
            (other) => other.kind === need.kind && other.projectId === need.projectId,
          ) === index,
      );
      return {
        ...config,
        requestScopes: [
          ...config.requestScopes.filter((entry) => entry.requestId !== requestId),
          { requestId, needs: unique },
        ].slice(-MAX_REQUEST_SCOPES),
      };
    });
    const titles = new Map<string, string>();
    for (const project of (yield* scope.view((yield* store.get).permissions)).projects) {
      titles.set(project.id, project.title);
    }
    yield* notice({
      key: `access:${requestId}:${needs.map((need) => `${need.kind}-${need.projectId}`).join(",")}`,
      threadId: requestThreadId(requestId),
      text: accessGrantedPrompt({ requestId, granted: needs, titles, approvedBy }),
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: "Access granted for a request",
      },
    }).pipe(Effect.mapError(() => fail("failed", "Could not resume the request.")));
  });

  const propose: PersonalAgentService["Service"]["propose"] = Effect.fn(
    "PersonalAgentService.propose",
  )(function* (input) {
    const config = yield* requireRequestThread(input.callerThreadId, input.requestId);
    const action = input.proposal.action;
    const mode = yield* grantFor(action, config);
    if (mode === "deny") {
      return yield* fail(
        "not_permitted",
        `Your user does not allow "${action.kind}" for that target. Propose something else, or decline and say what would need allowing.`,
      );
    }
    // Suspicious content never runs by rules: a person looks first.
    const byRules = mode === "auto" && input.proposal.suspicious.length === 0;
    if (byRules && action.kind === "grant_access") {
      yield* grantAccess(input.requestId, action.needs, "rules");
      return { outcome: "granted", requestId: input.requestId } satisfies ProposeOutcome;
    }
    const response = yield* relay.propose(input.requestId, {
      ...input.proposal,
      proposedAt: DateTime.formatIso(yield* DateTime.now),
    });
    if (response === null) return yield* fail("relay_unavailable");
    if (!byRules) return { outcome: "awaiting_owner", requestId: input.requestId };
    const decided = yield* relay.decideByRules(input.requestId, {
      action,
      text: input.proposal.draft,
    });
    if (decided === null) return yield* fail("relay_unavailable");
    return { outcome: "running", requestId: input.requestId } satisfies ProposeOutcome;
  });

  const requireThreadAccess = Effect.fn("PersonalAgentService.requireThreadAccess")(function* (
    callerThreadId: ThreadId,
  ) {
    const requestId = requestIdOfThread(callerThreadId);
    if (requestId === null) {
      return yield* fail("not_permitted", "Only a colleague request's thread uses this tool.");
    }
    const config = yield* store.get;
    return approvedNeeds(config, requestId).flatMap((need) =>
      need.kind === "read_threads" ? [need.projectId] : [],
    );
  });

  const readPriorRequest: PersonalAgentService["Service"]["readPriorRequest"] = Effect.fn(
    "PersonalAgentService.readPriorRequest",
  )(function* (callerThreadId, priorId) {
    const requestId = requestIdOfThread(callerThreadId);
    if (requestId === null) {
      return yield* fail("not_permitted", "Only a colleague request's thread uses this tool.");
    }
    const config = yield* store.get;
    if (!config.permissions.usePriorRequests) {
      return yield* fail("not_permitted", "Your user turned off earlier requests.");
    }
    const response = yield* relay.prior(requestId);
    if (response === null) return yield* fail("relay_unavailable");
    const earlier = response.requests.find((candidate) => candidate.id === priorId.trim());
    if (earlier === undefined) {
      return yield* fail(
        "not_permitted",
        "Only the earlier requests listed for this request can be read.",
      );
    }
    return {
      requestId: earlier.id,
      createdAt: earlier.createdAt,
      status: earlier.status,
      summary: earlier.proposal?.summary ?? null,
      body: earlier.body,
      context: earlier.context,
      reply: earlier.reply?.text ?? null,
      declineReason: earlier.status === "rejected" ? (earlier.decision?.reason ?? null) : null,
    } satisfies PriorRequestDetail;
  });

  const listThreads: PersonalAgentService["Service"]["listThreads"] = Effect.fn(
    "PersonalAgentService.listThreads",
  )(function* (callerThreadId) {
    return yield* scope.listThreads(yield* requireThreadAccess(callerThreadId));
  });

  const readThread: PersonalAgentService["Service"]["readThread"] = Effect.fn(
    "PersonalAgentService.readThread",
  )(function* (callerThreadId, threadId) {
    const projects = yield* requireThreadAccess(callerThreadId);
    const projectId = yield* scope.projectOfThread(threadId);
    if (projectId === null || !projects.some((id) => id === projectId)) {
      return yield* fail(
        "not_permitted",
        "That thread is outside the access granted for this request. Ask for read_threads on its project with grant_access.",
      );
    }
    const records = yield* orchestrator
      .getThreadRecords(ThreadId.make(threadId), ["messages", "turnItems"])
      .pipe(Effect.mapError(() => fail("not_found")));
    const clip = (text: string) =>
      text.length <= THREAD_READ_MESSAGE_CHARS
        ? text
        : `${text.slice(0, THREAD_READ_MESSAGE_CHARS)}…`;
    const entries = [
      ...records.messages.map((message) => ({
        role: "user" as const,
        text: message.text,
        order: DateTime.toEpochMillis(message.createdAt),
      })),
      ...records.turnItems.flatMap((item) =>
        item.type === "assistant_message" && "text" in item && typeof item.text === "string"
          ? [
              {
                role: "assistant" as const,
                text: item.text,
                order: DateTime.toEpochMillis(item.updatedAt),
              },
            ]
          : [],
      ),
    ]
      .filter((entry) => entry.text.trim() !== "")
      .toSorted((left, right) => left.order - right.order)
      .slice(-THREAD_READ_MESSAGES);
    return entries.map((entry) => ({ role: entry.role, text: clip(entry.text) }));
  });

  const report = (
    request: AgentRequest,
    state: "running" | "done" | "failed",
    detail?: string,
    result?: string,
    replyWithApprovedText?: boolean,
  ) =>
    relay
      .reportExecution(request.id, {
        state,
        ...(detail === undefined ? {} : { detail }),
        ...(result === undefined ? {} : { result }),
        ...(replyWithApprovedText ? { replyWithApprovedText } : {}),
      })
      .pipe(Effect.map((response) => response?.request ?? null));

  /** Runs the owner's accepted action through #21's assign path, with the owner's text. */
  const assign = Effect.fn("PersonalAgentService.assign")(function* (
    request: AgentRequest,
    agentThreadId: ThreadId,
    targetThreadId: ThreadId,
  ) {
    const self = yield* environmentId;
    yield* dispatch({
      type: "link_task.assign",
      commandId: CommandId.make(`personal-agent:assign:${request.id}`),
      // The agent thread has no run waiting on this: its half is not written, and the result
      // comes back through onRunUpdated, not LinkService.
      remote: "requester",
      taskId: NodeId.make(`personal-agent-task:${request.id}`),
      requester: { environmentId: self, threadId: agentThreadId },
      assignee: { environmentId: self, threadId: targetThreadId },
      task: assignmentText(request),
      link: {
        linkId: LinkGroupId.make(`${AGENT_TASK_PREFIX}${request.id}`),
        chainId: LinkChainId.make(`${AGENT_TASK_PREFIX}${request.id}`),
        hop: 1,
        parentTaskId: null,
      },
      sender: {
        threadTitle: AGENT_TITLE,
        projectTitle: AGENT_TITLE,
        purpose: `a request from ${accountLabel(request.from.accountId)} that you approved`,
      },
    });
  });

  const execute = Effect.fn("PersonalAgentService.execute")(function* (
    request: AgentRequest,
    config: PersonalAgentStore.PersonalAgentConfig,
  ) {
    const action = request.decision?.action;
    if (action === undefined || config.threadId === null) return;
    // The owner approved it, so ask is fine; a grant changed to deny since then still stops it.
    if ((yield* grantFor(action, config)) === "deny") {
      yield* report(request, "failed", "Your agent is no longer permitted to do this.");
      return;
    }
    if (action.kind === "grant_access") {
      yield* grantAccess(request.id, action.needs, "owner");
      yield* report(request, "done", "Access granted.");
      return;
    }
    const outcome = yield* Effect.gen(function* () {
      switch (action.kind) {
        case "send_to_thread":
          yield* assign(request, requestThreadId(request.id), action.threadId);
          return { state: "running" as const, detail: "Sent to your thread." };
        case "start_thread": {
          const threadId = workThreadId(request.id);
          const agent = yield* orchestrator.getThreadShell(config.threadId!);
          if (agent === null)
            return { state: "failed" as const, detail: "The agent thread is gone." };
          yield* dispatch({
            type: "thread.create",
            commandId: CommandId.make(`personal-agent:start:${request.id}`),
            threadId,
            projectId: action.projectId,
            title:
              action.title ??
              (assignmentText(request).split("\n")[0]?.slice(0, 80) || "Colleague request"),
            modelSelection: agent.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "server",
          });
          // Only opened: nothing for an agent to do, so no turn starts in it.
          if (assignmentText(request) === "") {
            return { state: "done" as const, detail: "Opened a thread for it.", replied: true };
          }
          yield* assign(request, requestThreadId(request.id), threadId);
          return { state: "running" as const, detail: "Started a thread for it." };
        }
        case "share_thread": {
          // A person's action: the owner approved this exact share on the card.
          yield* shares
            .grant({
              threadId: action.threadId,
              target: {
                kind: "account",
                id: request.from.accountId,
                label: request.from.accountId,
              },
              role: action.role,
            })
            .pipe(
              Effect.catchTags({
                ThreadShareError: (error) =>
                  error.reason === "duplicate" ? Effect.void : Effect.fail(error),
              }),
            );
          return {
            state: "done" as const,
            detail: `Shared the thread as ${action.role}.`,
            replied: true,
          };
        }
        default:
          return null;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Personal agent action failed", { cause }).pipe(
          Effect.as({ state: "failed" as const, detail: "The action could not run." }),
        ),
      ),
    );
    if (outcome === null) return;
    // Done with nothing to report: the text the owner approved goes to the colleague as is.
    const replyNow =
      "replied" in outcome && outcome.replied === true && request.decision!.text.trim() !== "";
    const updated = yield* report(request, outcome.state, outcome.detail, undefined, replyNow);
    if (updated !== null && updated.status === "accepted" && outcome.state !== "running") {
      yield* draftReply(updated, config);
    }
  });

  /** After the work, the agent drafts the answer; the owner approves it again. */
  const draftReply = (request: AgentRequest, config: PersonalAgentStore.PersonalAgentConfig) =>
    config.threadId === null
      ? Effect.void
      : notice({
          key: `result:${request.id}`,
          threadId: requestThreadId(request.id),
          text: workResultPrompt(request, config.instructions),
          notification: {
            source: { kind: "system" },
            outcome: request.execution?.state === "failed" ? "failed" : "completed",
            summary: "Approved work finished; drafting the answer",
          },
        }).pipe(Effect.ignore);

  /** A hidden thread in the agent's project, on the agent window's model, for this request only. */
  const ensureRequestThread = Effect.fn("PersonalAgentService.ensureRequestThread")(function* (
    request: AgentRequest,
    agentThreadId: ThreadId,
  ) {
    const threadId = requestThreadId(request.id);
    if ((yield* liveShell(threadId)) !== null) return threadId;
    const agent = yield* orchestrator.getThreadShell(agentThreadId);
    const config = yield* store.get;
    if (agent === null || config.projectId === null) {
      return yield* Effect.die(new Error("The personal agent thread is gone."));
    }
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(`personal-agent:request-thread:${request.id}`),
      threadId,
      projectId: config.projectId,
      title: `Request ${request.id}`,
      modelSelection: agent.modelSelection,
      // The runtime policy holds every turn read-only regardless (PersonalAgentRuntimePolicy).
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "server",
    });
    yield* dispatch({
      type: "thread.auto-settle.set",
      commandId: CommandId.make(`personal-agent:request-no-settle:${request.id}`),
      threadId,
      enabled: false,
    }).pipe(Effect.ignore);
    return threadId;
  });

  const agentConfinesReads = (config: PersonalAgentStore.PersonalAgentConfig) =>
    config.providerInstanceId === null
      ? Effect.succeed(false)
      : registry
          .getInstance(config.providerInstanceId)
          .pipe(
            Effect.map(
              (instance) =>
                instance !== undefined && confinesReadsToGrantedPaths(instance.driverKind),
            ),
          );

  /**
   * The owner decided without the agent (answered, rejected, forwarded) or the request closed: its
   * triage or drafting turn, running or queued, has nothing left to do.
   */
  const stopAgentWork = Effect.fn("PersonalAgentService.stopAgentWork")(function* (
    request: AgentRequest,
    agentThreadId: ThreadId,
  ) {
    const messageIds = new Set([
      `personal-agent:triage:${request.id}`,
      `personal-agent:result:${request.id}`,
    ]);
    const { runs } = yield* orchestrator.getThreadRecords(agentThreadId, ["runs"]);
    for (const run of runs) {
      if (!messageIds.has(run.userMessageId) || isTerminalRun(run)) continue;
      const commandId = CommandId.make(`personal-agent:stop:${request.id}:${run.id}`);
      yield* dispatch(
        run.status === "queued"
          ? { type: "queued-run.cancel", commandId, threadId: agentThreadId, runId: run.id }
          : {
              type: "run.interrupt",
              commandId,
              threadId: agentThreadId,
              runId: run.id,
              reason: "The request was already decided",
            },
      ).pipe(Effect.ignore);
    }
  });

  const handleInbox = Effect.fn("PersonalAgentService.handleInbox")(function* (
    request: AgentRequest,
  ) {
    const config = yield* store.get;
    if (config.threadId === null) return;
    if (!isAgentRequestOpen(request.status)) {
      yield* stopAgentWork(request, requestThreadId(request.id));
      return;
    }
    if (!config.enabled) return;
    if (request.status === "pending" && request.proposal === null) {
      if ((yield* liveShell(requestThreadId(request.id))) !== null) {
        // Triaged already, but nothing reached the card (the proposal call failed, or the turn
        // ended without one): once its turns are over, ask the request's thread to propose.
        const { runs } = yield* orchestrator
          .getThreadRecords(requestThreadId(request.id), ["runs"])
          .pipe(Effect.orElseSucceed(() => ({ runs: [] as ReadonlyArray<OrchestrationV2Run> })));
        if (runs.length > 0 && runs.every(isTerminalRun)) {
          yield* notice({
            key: `triage-again:${request.id}`,
            threadId: requestThreadId(request.id),
            text: `Request ${request.id} still has no proposal, so your user has nothing to approve. Call fwai_code_agent_propose with requestId "${request.id}" now: grant_access if you need access, otherwise your answer or action.`,
            notification: {
              source: { kind: "system" },
              outcome: "updated",
              summary: "Request still needs a proposal",
            },
          });
        }
        return;
      }
      const triageThreadId = yield* ensureRequestThread(request, config.threadId);
      yield* notice({
        key: `triage:${request.id}`,
        threadId: triageThreadId,
        text: triagePrompt({
          request,
          prior: config.permissions.usePriorRequests
            ? ((yield* relay.prior(request.id))?.requests ?? [])
            : [],
          fromLabel: accountLabel(request.from.accountId),
          permissions: config.permissions,
          view: yield* scope.view(config.permissions),
          instructions: config.instructions,
          pathsEnforced: yield* agentConfinesReads(config),
        }),
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: "New request to triage",
        },
      });
      return;
    }
    if (request.status !== "accepted" || request.execution === null) return;
    if (request.execution.state === "pending") {
      yield* execute(request, config);
      return;
    }
    const needsDraft =
      request.decision?.action.kind !== "grant_access" &&
      (request.execution.state === "done" || request.execution.state === "failed") &&
      (request.proposal === null || request.proposal.proposedAt < request.execution.updatedAt);
    if (needsDraft) yield* draftReply(request, config);
  });

  const WAKE_STATUSES = new Set(["replied", "rejected", "expired"]);

  const liveShell = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.map((shell) =>
        shell !== null && shell.deletedAt === null && shell.archivedAt === null ? shell : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  /**
   * Where an outcome lands: the asking thread; when that is gone (a draft that never started,
   * archived, deleted), the requester's own agent thread, which relays it; without one, a new
   * thread in the project the request was sent from.
   */
  const outcomeThread = Effect.fn("PersonalAgentService.outcomeThread")(function* (
    request: AgentRequest,
  ) {
    if ((yield* liveShell(request.from.threadId)) !== null) {
      return { threadId: request.from.threadId, relayed: false } as const;
    }
    const config = yield* store.get;
    if (config.threadId !== null && (yield* liveShell(config.threadId)) !== null) {
      return { threadId: config.threadId, relayed: true } as const;
    }
    const origin = config.askOrigins.find((entry) => entry.requestId === request.id)?.origin;
    if (origin === undefined) return null;
    const threadId = ThreadId.make(`agent-reply-${request.id}`);
    if ((yield* liveShell(threadId)) === null) {
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(`personal-agent:reply-thread:${request.id}`),
        threadId,
        projectId: origin.projectId,
        title: `Ask ${accountLabel(request.toAccountId)}: ${request.body.split("\n")[0]?.slice(0, 60) ?? ""}`,
        modelSelection: origin.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
      });
    }
    return { threadId, relayed: true } as const;
  });

  const handleOutbox = Effect.fn("PersonalAgentService.handleOutbox")(function* (
    request: AgentRequest,
  ) {
    if (!WAKE_STATUSES.has(request.status)) return;
    const target = yield* outcomeThread(request);
    if (target === null) {
      yield* Effect.logWarning("Personal agent reply has nowhere to land", {
        requestId: request.id,
      });
      return;
    }
    // Wakes the receiving thread once per outcome, like a link task result.
    yield* notice({
      key: `wake:${request.id}:${request.status}`,
      threadId: target.threadId,
      text: requesterWakeText({
        request,
        toLabel: accountLabel(request.toAccountId),
        relayed: target.relayed,
      }),
      notification: {
        source: { kind: "system" },
        outcome:
          request.status === "replied"
            ? "completed"
            : request.status === "expired"
              ? "cancelled"
              : "failed",
        summary:
          request.status === "replied"
            ? "A colleague's agent answered"
            : request.status === "expired"
              ? "Your request expired"
              : "A colleague declined your request",
      },
    });
  });

  /** `inbox`: a request to this account's agent. `outbox`: one sent from this environment. */
  const handle = (role: "inbox" | "outbox", request: AgentRequest) =>
    handling
      .withPermits(1)(role === "inbox" ? handleInbox(request) : handleOutbox(request))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Personal agent could not handle a request", {
            requestId: request.id,
            cause,
          }),
        ),
      );

  const syncNow = Effect.gen(function* () {
    const synced = yield* relay.sync;
    yield* Ref.set(relayLinked, synced !== null);
    if (synced === null) return;
    yield* Ref.set(lastSync, synced);
    const isAgentEnvironment = synced.agent?.environmentId === (yield* environmentId);
    const config = yield* store.get;
    // Turned on elsewhere: this environment stops taking requests; its thread stays as history.
    if (config.enabled !== isAgentEnvironment) {
      yield* store
        .update((current) => ({ ...current, enabled: isAgentEnvironment }))
        .pipe(Effect.ignore);
    }
    for (const request of synced.outbox) yield* handle("outbox", request);
    for (const request of synced.inbox) yield* handle("inbox", request);
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Personal agent sync failed", { cause })),
    Effect.withSpan("PersonalAgentService.sync"),
  );

  const receive: PersonalAgentService["Service"]["receive"] = Effect.fn(
    "PersonalAgentService.receive",
  )(function* (delivery) {
    // The relay addressed this environment; the kind says in which role.
    yield* handle(delivery.kind === "reply" ? "outbox" : "inbox", delivery.request);
  });

  const onRunUpdated: PersonalAgentService["Service"]["onRunUpdated"] = Effect.fn(
    "PersonalAgentService.onRunUpdated",
  )(
    function* (threadId, run) {
      const requestId = agentRequestIdOfRun(run);
      if (requestId === null || !isTerminalRun(run)) return;
      if (yield* orchestrator.restartContinuationPending(run)) return;
      const records = yield* orchestrator.getThreadRecords(threadId, ["messages", "turnItems"], {
        messageRoles: ["assistant"],
        messageRunIds: [run.id],
        turnItemRunId: run.id,
        turnItemTypes: ["assistant_message", "error"],
      });
      const text = subagentResultForRun(records, run).text.slice(0, 32_000);
      const response = yield* relay.reportExecution(requestId, {
        state: run.status === "completed" ? "done" : "failed",
        detail:
          run.status === "completed" ? "Your thread finished the work." : `The run ${run.status}.`,
        result: text,
      });
      if (response !== null) yield* draftReply(response.request, yield* store.get);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Personal agent could not return a result", { cause }),
    ),
  );

  return PersonalAgentService.of({
    getState,
    setEnabled,
    configure,
    setPermissions,
    ask,
    isAgentThread,
    isRequestThread: isRequestThreadId,
    inbox,
    propose,
    listThreads,
    readPriorRequest,
    colleagues,
    readThread,
    receive,
    sync: syncNow,
    onRunUpdated,
  });
});

/** Watches the dispatched runs and catches up with the relay while the server runs. */
const watchers = Effect.gen(function* () {
  const service = yield* PersonalAgentService;
  const eventSink = yield* EventSink.EventSinkV2;
  const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
  yield* eventSink.stream({ afterSequence, eventType: "run.updated" }).pipe(
    Stream.runForEach((stored) =>
      stored.event.type === "run.updated" && agentRequestIdOfRun(stored.event.payload) !== null
        ? service.onRunUpdated(stored.event.threadId, stored.event.payload)
        : Effect.void,
    ),
    Effect.forkScoped,
  );
  // Requests decided while this environment was offline run once it is back.
  yield* service.sync.pipe(Effect.repeat(Schedule.spaced("2 minutes")), Effect.forkScoped);
});

export const layer = Layer.effect(PersonalAgentService, make);
export const layerWatchers = Layer.effectDiscard(watchers);
