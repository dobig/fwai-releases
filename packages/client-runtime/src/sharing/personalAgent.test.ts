import { describe, expect, it } from "vite-plus/test";
import {
  AgentRequestId,
  EMPTY_PERSONAL_AGENT_PERMISSIONS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentProposal,
  type AgentRequest,
} from "@t3tools/contracts";

import {
  acceptDecision,
  chooseAgentModel,
  parseAskCommand,
  proposedTask,
  requestsAwaitingDecision,
  requestsForThread,
  withExtraReadPath,
  withProjectGrant,
  withSendTarget,
} from "./personalAgent.ts";

const request = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  id: AgentRequestId.make("areq_1"),
  organizationId: "org",
  from: {
    accountId: "bob",
    environmentId: EnvironmentId.make("bob-env"),
    threadId: ThreadId.make("t1"),
    threadTitle: "fwai_code",
  },
  toAccountId: "alice",
  body: "question",
  context: null,
  status: "pending",
  proposal: null,
  decision: null,
  execution: null,
  reply: null,
  forwardedFrom: null,
  forwardedTo: null,
  createdAt: "2026-11-12T10:00:00.000Z",
  updatedAt: "2026-11-12T10:00:00.000Z",
  expiresAt: "2026-11-19T10:00:00.000Z",
  ...overrides,
});

describe("parseAskCommand", () => {
  it("takes the username and keeps the whole body, line breaks included", () => {
    expect(parseAskCommand("/ask alice what does\nintrospection return?")).toEqual({
      username: "alice",
      body: "what does\nintrospection return?",
    });
    expect(parseAskCommand("/ASK @alice hi")).toEqual({ username: "alice", body: "hi" });
    expect(parseAskCommand("/ask")).toEqual({ username: "", body: "" });
    expect(parseAskCommand("please /ask alice")).toBeNull();
    expect(parseAskCommand("/asked alice")).toBeNull();
  });
});

describe("acceptDecision", () => {
  it("sends the owner's text as an answer even when the agent proposed to decline", () => {
    const declined = request({
      proposal: {
        summary: "Asks for credentials",
        action: { kind: "decline" },
        draft: "",
        disclosure: [],
        suspicious: [],
        proposedAt: "t",
      },
    });
    expect(acceptDecision(declined, "Here is what I can share.")).toEqual({
      decision: "accept",
      action: { kind: "answer" },
      text: "Here is what I can share.",
    });
  });
});

describe("request lists", () => {
  it("shows a thread only the requests it sent", () => {
    const mine = request();
    const other = request({
      id: AgentRequestId.make("areq_2"),
      from: { ...mine.from, threadId: ThreadId.make("t2") },
    });
    expect(
      requestsForThread([mine, other], { environmentId: "bob-env", threadId: "t1" }).map(
        (r) => r.id,
      ),
    ).toEqual(["areq_1"]);
  });

  it("drops a request from the thread's cards once it is answered", () => {
    const replied = request({ status: "replied", reply: { text: "2", at: "t" } });
    expect(requestsForThread([replied], { environmentId: "bob-env", threadId: "t1" })).toEqual([]);
  });

  it("asks the owner again only once the approved work came back with a new draft", () => {
    const proposal = {
      summary: "s",
      action: { kind: "answer" as const },
      draft: "d",
      disclosure: [],
      suspicious: [],
      proposedAt: "2026-11-12T12:00:00.000Z",
    };
    const running = request({
      status: "accepted",
      proposal: { ...proposal, proposedAt: "2026-11-12T10:10:00.000Z" },
      execution: {
        state: "running",
        detail: null,
        result: null,
        updatedAt: "2026-11-12T11:00:00.000Z",
      },
    });
    const drafted = request({
      status: "accepted",
      proposal,
      execution: {
        state: "done",
        detail: null,
        result: "r",
        updatedAt: "2026-11-12T11:00:00.000Z",
      },
    });
    expect(requestsAwaitingDecision([request(), running, drafted]).length).toBe(2);
    // The second approval only answers; the work does not run again.
    expect(acceptDecision(drafted, "edited")).toEqual({
      decision: "accept",
      action: { kind: "answer" },
      text: "edited",
    });
  });

  it("keeps a thread's task apart from the words to the colleague", () => {
    const proposal: AgentProposal = {
      summary: "s",
      action: { kind: "answer" },
      draft: "",
      disclosure: [],
      suspicious: [],
      proposedAt: "2026-11-12T10:00:00.000Z",
    };
    const starting = request({
      proposal: {
        ...proposal,
        action: { kind: "start_thread", projectId: ProjectId.make("p"), title: "测试" },
        draft: "Opened 测试 for you.",
      },
    });
    expect(proposedTask(starting)).toBe("");
    expect(acceptDecision(starting, "Opened 测试 for you.", "  ")).toEqual({
      decision: "accept",
      action: { kind: "start_thread", projectId: "p", title: "测试" },
      text: "Opened 测试 for you.",
    });
    expect(acceptDecision(starting, "On it.", " Write the notes. ")).toEqual({
      decision: "accept",
      action: { kind: "start_thread", projectId: "p", title: "测试", task: "Write the notes." },
      text: "On it.",
    });
    // A send proposed before tasks existed carried its task in the draft.
    const legacySend = request({
      proposal: {
        ...proposal,
        action: { kind: "send_to_thread", threadId: ThreadId.make("t") },
        draft: "Check the logs.",
      },
    });
    expect(proposedTask(legacySend)).toBe("Check the logs.");
  });
});

describe("agent settings", () => {
  const project = ProjectId.make("p1");

  it("keeps a project row only while it overrides something", () => {
    const overridden = withProjectGrant(EMPTY_PERSONAL_AGENT_PERMISSIONS, project, "send", "auto");
    expect(overridden.projects).toEqual([{ projectId: project, grants: { send: "auto" } }]);
    expect(withProjectGrant(overridden, project, "send", "inherit").projects).toEqual([]);
  });

  it("adds only new absolute folders, without a trailing slash", () => {
    const added = withExtraReadPath(EMPTY_PERSONAL_AGENT_PERMISSIONS, " /srv/docs/ ");
    expect(added.extraReadPaths).toEqual(["/srv/docs"]);
    expect(withExtraReadPath(added, "/srv/docs")).toBe(added);
    expect(withExtraReadPath(added, "relative/path")).toBe(added);
  });

  it("shows the running model until the owner picks another provider", () => {
    const providers = [
      { instanceId: "codex", models: [{ slug: "a" }, { slug: "b", isDefault: true }] },
      { instanceId: "claude", models: [{ slug: "c" }, { slug: "d" }] },
    ];
    const running = {
      providerInstanceId: ProviderInstanceId.make("claude"),
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "d" },
    };
    const none = { instanceId: null, model: null };
    expect(chooseAgentModel(providers, none, running)).toMatchObject({ model: "d" });
    expect(
      chooseAgentModel(providers, { instanceId: "codex", model: null }, running),
    ).toMatchObject({ model: "b" });
    expect(chooseAgentModel(providers, none, null).provider?.instanceId).toBe("codex");
  });

  it("points only an accepted send at another thread", () => {
    const send = {
      decision: "accept" as const,
      action: { kind: "send_to_thread" as const, threadId: ThreadId.make("t1") },
      text: "",
    };
    expect(withSendTarget(send, ThreadId.make("t2"))).toMatchObject({
      action: { threadId: "t2" },
    });
    const reject = { decision: "reject" as const };
    expect(withSendTarget(reject, ThreadId.make("t2"))).toBe(reject);
  });
});
