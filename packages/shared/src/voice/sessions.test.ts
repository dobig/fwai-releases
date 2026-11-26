import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "./config.ts";
import type { Intent, SessionListing, VoiceLlm } from "./llm.ts";
import {
  mentions,
  Sessions,
  speakable,
  VOICE_NOTE,
  type VoiceState,
  type VoiceStateStore,
  type VoiceT3,
  type VoiceThread,
} from "./sessions.ts";
import type { CueName, SpeakerPort } from "./speaker.ts";

class FakeSpeaker implements SpeakerPort {
  said: Array<string> = [];
  followups: Array<string | null> = [];
  chimes = 0;
  last: string | null = null;

  say(text: string, options?: { readonly followup?: string | null }) {
    this.said.push(text);
    this.followups.push(options?.followup ?? null);
    this.last = text;
  }

  cue(name: CueName) {
    if (name === "chime") this.chimes++;
    else this.said.push(`<${name}>`);
  }
}

type Sent = [threadId: string, message: string, mode: string | null];

class FakeT3 implements VoiceT3 {
  sent: Array<Sent> = [];
  raw: Array<string> = [];
  approvals: Array<[string, string, string]> = [];
  launched: Array<[string, string, string]> = [];
  reply = "全部测试通过";
  questions: ReadonlyArray<unknown> = [];

  async projects(): Promise<ReadonlyArray<{ id: string; title: string }>> {
    return [];
  }
  async threads(): Promise<ReadonlyArray<VoiceThread>> {
    return [];
  }
  async send(threadId: string, text: string, mode: string) {
    this.raw.push(text);
    this.sent.push([
      threadId,
      text.endsWith(VOICE_NOTE) ? text.slice(0, -VOICE_NOTE.length) : text,
      mode,
    ]);
  }
  async interrupt(threadId: string) {
    this.sent.push([threadId, "<interrupt>", null]);
  }
  async lastExchange() {
    return { asked: "问题", text: this.reply };
  }
  async pendingQuestions() {
    return this.questions;
  }
  async respondToApproval(threadId: string, requestId: string, decision: "accept" | "decline") {
    this.approvals.push([threadId, requestId, decision]);
  }
  async launch(projectId: string, message: string, mode: string) {
    this.launched.push([projectId, message.slice(0, -VOICE_NOTE.length), mode]);
    return { threadId: `new${this.launched.length}` };
  }
}

class FakeLlm implements VoiceLlm {
  private readonly intent: Intent;
  constructor(intent: Intent = {}) {
    this.intent = intent;
  }
  async parseIntent(
    _utterance: string,
    _sessions: ReadonlyArray<SessionListing>,
    _current: number | null,
  ): Promise<Intent> {
    return this.intent;
  }
  async summarize(
    text: string,
    _question?: string | null,
    options?: { readonly detailed?: boolean },
  ) {
    return (options?.detailed ? "【详细】" : "") + text;
  }
  async extractQuestions(text: string) {
    return text.split("\n").filter((line) => line.endsWith("？"));
  }
  async mergeNotices(name: string, parts: ReadonlyArray<string>) {
    return `${name}：${parts.join(" / ")}`;
  }
  async readQuestion(request: string) {
    return String((JSON.parse(request) as Array<unknown>)[0]);
  }
}

/** One intent per call, in order; `session` is a name, resolved to the listing's index. */
class ScriptedLlm extends FakeLlm {
  private readonly intents: Array<Omit<Intent, "session"> & { session?: string | null }>;
  constructor(...intents: Array<Omit<Intent, "session"> & { session?: string | null }>) {
    super();
    this.intents = intents;
  }
  override async parseIntent(
    _utterance: string,
    sessions: ReadonlyArray<SessionListing>,
  ): Promise<Intent> {
    const { session, ...intent } = this.intents.shift()!;
    return { ...intent, session: sessions.find((s) => s.name === session)?.index ?? null };
  }
}

/** Fails the test if the fast path should have answered. */
class NoLlm extends FakeLlm {
  override async parseIntent(utterance: string): Promise<Intent> {
    throw new Error(`LLM asked about ${utterance}`);
  }
}

class MemoryStore implements VoiceStateStore {
  json = "{}";
  load(): VoiceState {
    return JSON.parse(this.json) as VoiceState;
  }
  save(state: VoiceState) {
    this.json = JSON.stringify(state);
  }
}

const config = () => ({ ...DEFAULT_VOICE_CONFIG, aliases: { 网关: "gateway" } });

function thread(
  status: string,
  run: string | null = "r1",
  overrides: Partial<VoiceThread> = {},
): VoiceThread {
  return {
    threadId: "t1",
    projectId: "p1",
    title: "llm gateway 重构",
    status,
    latestRunId: run,
    itemCount: 3,
    pendingRequest: null,
    ...overrides,
  };
}

const docs = (status = "idle") =>
  thread(status, "r9", { threadId: "t2", title: "改文档", itemCount: 2 });

function make(
  options: {
    t3?: FakeT3;
    llm?: VoiceLlm;
    store?: VoiceStateStore;
    speaker?: FakeSpeaker;
    now?: () => number;
    config?: () => VoiceConfig;
  } = {},
) {
  const speaker = options.speaker ?? new FakeSpeaker();
  const t3 = options.t3 ?? new FakeT3();
  const sessions = new Sessions({
    config: options.config ?? config,
    t3,
    llm: options.llm ?? new FakeLlm(),
    speaker,
    ...(options.store ? { store: options.store } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { sessions, speaker, t3 };
}

function twoSessions(sessions: Sessions) {
  sessions.observe(thread("idle"), "yongheng");
  sessions.observe(docs(), "yongheng");
  sessions.initialized = true;
}

const tracked = (sessions: Sessions, id: string) => sessions.tracked.get(id)!;

describe("announcing", () => {
  it("announces a finish, including runs shorter than a poll", async () => {
    const { sessions, speaker } = make();
    sessions.observe(thread("completed", "r1"), "yongheng");
    sessions.initialized = true;
    sessions.observe(thread("running", "r2"), "yongheng");
    sessions.observe(thread("completed", "r2"), "yongheng");
    sessions.observe(thread("completed", "r3"), "yongheng"); // started and ended between polls
    sessions.observe(thread("completed", "r3"), "yongheng"); // no change: no announcement
    await sessions.settled();
    expect(speaker.said).toEqual(["网关做完了。全部测试通过", "网关做完了。全部测试通过"]);
  });

  it("leaves out the current session's name", async () => {
    const { sessions, speaker } = make();
    sessions.observe(thread("running", "r1"), "yongheng");
    sessions.initialized = true;
    sessions.current = "t1";
    sessions.observe(thread("completed", "r1"), "yongheng");
    await sessions.settled();
    expect(speaker.said).toEqual(["做完了。全部测试通过"]);
  });

  it("announces a question once, and again when a new one is asked", async () => {
    const t3 = new FakeT3();
    t3.reply = "用哪个日志级别？";
    t3.questions = ["用哪个日志级别？"];
    const { sessions, speaker } = make({ t3 });
    sessions.observe(thread("running"), "yongheng");
    sessions.initialized = true;
    const asking = { id: "q1", kind: "user_input" };
    sessions.observe(thread("waiting", "r1", { pendingRequest: asking }), "yongheng");
    sessions.observe(thread("waiting", "r1", { pendingRequest: asking }), "yongheng"); // same question again
    await sessions.settled();
    expect(speaker.said).toEqual(["网关在等你回答。用哪个日志级别？"]);
    sessions.observe(
      thread("waiting", "r1", { pendingRequest: { id: "q2", kind: "user_input" } }),
      "yongheng",
    );
    await sessions.settled();
    expect(speaker.said).toHaveLength(2);
    sessions.observe(thread("running"), "yongheng"); // answered
    await sessions.settled();
    expect(speaker.said).toHaveLength(2);
    expect(tracked(sessions, "t1").questionPending).toBe(false);
  });

  it("asks for an approval by voice, and approves it", async () => {
    const { sessions, speaker, t3 } = make({
      llm: new ScriptedLlm({ action: "approve", message: "accept" }),
    });
    sessions.observe(thread("running"), "yongheng");
    sessions.initialized = true;
    sessions.observe(
      thread("waiting", "r1", { pendingRequest: { id: "a1", kind: "command" } }),
      "yongheng",
    );
    await sessions.settled();
    expect(speaker.said).toEqual(["网关在等你批准执行一条命令。说“批准”或者“拒绝”。"]);
    expect(tracked(sessions, "t1").questionPending).toBe(false);
    await sessions.handle("批准");
    expect(t3.approvals).toEqual([["t1", "a1", "accept"]]);
    expect(speaker.said.at(-1)).toBe("批准了，网关接着做。");
  });

  it("says so when nothing waits for an approval", async () => {
    const { sessions, speaker, t3 } = make({
      llm: new ScriptedLlm({ action: "approve", message: "decline" }),
    });
    twoSessions(sessions);
    await sessions.handle("拒绝");
    expect(t3.approvals).toEqual([]);
    expect(speaker.said).toEqual(["现在没有在等批准的操作。"]);
  });

  it("does not announce a finished run with no news", async () => {
    const llm = new FakeLlm();
    llm.summarize = async () => "SKIP";
    const { sessions, speaker } = make({ llm });
    sessions.observe(thread("running"), "yongheng");
    sessions.initialized = true;
    sessions.observe(thread("completed"), "yongheng");
    await sessions.settled();
    expect(speaker.said).toEqual([]);
    expect(sessions.inbox).toEqual([]);
  });

  it("only mentions other sessions, even while the current one runs", () => {
    const { sessions, speaker } = make();
    twoSessions(sessions);
    sessions.current = "t1";
    tracked(sessions, "t1").thread = thread("running");
    sessions.notify(tracked(sessions, "t2"), "改文档做完了。");
    expect(speaker.said).toEqual(["改文档有新通知。"]);
    sessions.notify(tracked(sessions, "t1"), "网关做完了。");
    sessions.notify(tracked(sessions, "t2"), "改文档又说了一句。"); // already mentioned: no second hint
    expect(speaker.said.slice(1)).toEqual(["网关做完了。"]);
  });

  it("hints right away and reads the inbox on request, one notice per session", async () => {
    const { sessions, speaker } = make({
      llm: new ScriptedLlm({ action: "inbox" }, { action: "inbox" }),
    });
    twoSessions(sessions);
    sessions.current = "t1";
    sessions.notify(tracked(sessions, "t2"), "改文档做完了。");
    sessions.notify(tracked(sessions, "t2"), "改文档在等你回答。");
    await sessions.settled();
    expect(speaker.said).toEqual(["改文档有新通知。"]);
    speaker.said = [];
    await sessions.handle("听通知");
    await sessions.handle("听通知");
    expect(speaker.said).toEqual(["改文档：改文档做完了。 / 改文档在等你回答。", "没有新通知。"]);
  });

  it("reads news from every session when announceAll is on", () => {
    const { sessions, speaker } = make({ config: () => ({ ...config(), announceAll: true }) });
    twoSessions(sessions);
    sessions.current = "t1";
    sessions.notify(tracked(sessions, "t2"), "改文档做完了。");
    expect(speaker.said).toEqual(["改文档做完了。"]);
    expect(sessions.inbox).toEqual([]);
  });

  it("announces everything when there is no current session", () => {
    const { sessions, speaker } = make();
    twoSessions(sessions);
    sessions.notify(tracked(sessions, "t2"), "改文档做完了。");
    expect(speaker.said).toEqual(["改文档做完了。"]);
  });

  it("announces the reply from a session the user messaged", async () => {
    const { sessions, speaker } = make({
      llm: new ScriptedLlm({ action: "send", session: "改文档", message: "产出多少了？" }),
    });
    twoSessions(sessions);
    sessions.current = "t1";
    sessions.notify(tracked(sessions, "t2"), "改文档旧通知。"); // unread, sits in the inbox
    await sessions.handle("给改文档发一句，产出多少了？");
    speaker.said = [];
    sessions.notify(tracked(sessions, "t2"), "改文档做完了。产出 7 个。"); // the reply
    sessions.notify(tracked(sessions, "t2"), "改文档又做完了。"); // later news: inbox again
    expect(speaker.said).toEqual(["改文档做完了。产出 7 个。"]);
  });

  it("mentions a session again after a while even with old notices unread", () => {
    let now = 1_000_000;
    const { sessions, speaker } = make({ now: () => now });
    twoSessions(sessions);
    sessions.current = "t1";
    sessions.notify(tracked(sessions, "t2"), "第一条。");
    now += Sessions.HINT_EVERY + 1;
    sessions.notify(tracked(sessions, "t2"), "第二条。");
    expect(speaker.said).toEqual(["改文档有新通知。", "改文档有新通知。"]);
  });

  it("merges news from one session into one notice", async () => {
    const { sessions, speaker } = make({ llm: new FakeLlm({ action: "inbox" }) });
    twoSessions(sessions);
    sessions.current = "t1";
    for (const text of [
      "改文档做完了。改了三处。",
      "改文档做完了。测试都过了。",
      "改文档在等你回答。要不要发版？",
    ]) {
      sessions.notify(tracked(sessions, "t2"), text);
      await sessions.settled();
    }
    const merged =
      "改文档：改文档做完了。改了三处。 / 改文档做完了。测试都过了。 / 改文档在等你回答。要不要发版？";
    expect(sessions.inbox.map((n) => n.text)).toEqual([merged]);
    speaker.said = [];
    await sessions.handle("听通知");
    expect(speaker.said).toEqual([merged]);
  });

  it("keeps a merge that lost a race from overwriting newer news", async () => {
    const { sessions } = make();
    twoSessions(sessions);
    sessions.current = "t1";
    sessions.notify(tracked(sessions, "t2"), "一。");
    sessions.notify(tracked(sessions, "t2"), "二。");
    sessions.notify(tracked(sessions, "t2"), "三。");
    await sessions.settled();
    expect(sessions.inbox.map((n) => n.text)).toEqual(["改文档：一。 / 二。 / 三。"]);
  });

  it("keeps one notice per session and trims a longer saved inbox", () => {
    const store = new MemoryStore();
    const { sessions } = make({ store });
    twoSessions(sessions);
    sessions.setCurrent("t1");
    for (let i = 0; i < 5; i++) sessions.notify(tracked(sessions, "t2"), `改文档第${i}条。`);
    sessions.notify(tracked(sessions, "t1"), "网关做完了。"); // current: spoken, not kept
    expect(sessions.inbox.map((n) => n.text)).toEqual(["改文档第4条。"]); // merges still pending

    const saved = JSON.parse(store.json) as VoiceState;
    store.json = JSON.stringify({
      ...saved,
      inbox: Array.from({ length: 6 }, (_, i) => ({
        threadId: "t2",
        text: `旧${i}`,
        hinted: true,
        parts: [],
      })),
    });
    expect(make({ store }).sessions.inbox.map((n) => n.text)).toEqual(["旧5"]);
  });

  it("speaks no words in passive mode until asked", async () => {
    const store = new MemoryStore();
    const { sessions, speaker } = make({
      store,
      llm: new ScriptedLlm({ action: "passive", message: "on" }, { action: "inbox" }),
    });
    twoSessions(sessions);
    sessions.setCurrent("t1");
    await sessions.handle("打开被动模式");
    expect(speaker.said.pop()).toMatch(/^被动模式开了/);
    sessions.notify(tracked(sessions, "t1"), "网关做完了。"); // even the current session
    sessions.notify(tracked(sessions, "t2"), "改文档做完了。");
    expect([speaker.said, speaker.chimes]).toEqual([[], 1]); // one chime for both
    await sessions.handle("听通知");
    expect(speaker.said).toEqual(["改文档做完了。", "网关做完了。"]); // reversed urgent calls: queue order 网关, 改文档
    expect(make({ store }).sessions.passive).toBe(true);
  });
});

describe("listing sessions", () => {
  const at = (id: string, status: string, updatedAt?: number) =>
    thread(status, "r1", {
      threadId: id,
      title: id,
      ...(updatedAt === undefined ? {} : { updatedAt }),
    });

  it("names the computer only when two computers have a session that sounds the same", () => {
    const { sessions } = make();
    sessions.observe(
      thread("idle", "r1", { threadId: "a:1", computer: "公司电脑", title: "数据管线" }),
      "p",
    );
    sessions.observe(
      thread("idle", "r1", { threadId: "b:1", computer: "家里电脑", title: "改文档" }),
      "p",
    );
    sessions.initialized = true;
    expect(sessions.snapshot().map((row) => row.name)).toEqual(["数据管线", "改文档"]);
    sessions.observe(
      thread("idle", "r1", { threadId: "b:2", computer: "家里电脑", title: "数据管线" }),
      "p",
    );
    expect(sessions.snapshot().map((row) => [row.name, row.computer])).toEqual(
      expect.arrayContaining([
        ["公司电脑的数据管线", "公司电脑"],
        ["家里电脑的数据管线", "家里电脑"],
        ["改文档", "家里电脑"],
      ]),
    );
  });

  it("puts what is running first, then the newest activity, not the oldest", () => {
    const { sessions } = make();
    sessions.observe(at("old", "idle", 1_000), "p");
    sessions.observe(at("newest", "idle", 9_000), "p");
    sessions.observe(at("running-old", "running", 500), "p");
    sessions.observe(at("middle", "idle", 5_000), "p");
    sessions.initialized = true;
    expect(sessions.snapshot().map((row) => row.id)).toEqual([
      "running-old",
      "newest",
      "middle",
      "old",
    ]);
    sessions.select("old");
    expect(sessions.snapshot().map((row) => row.id)).toEqual([
      "running-old",
      "old",
      "newest",
      "middle",
    ]);
  });

  it("lists up to 100 in the app but gives the model only the newest 30", () => {
    const { sessions } = make();
    for (let i = 0; i < 120; i++) sessions.observe(at(`s${i}`, "idle", i), "p");
    sessions.initialized = true;
    const rows = sessions.snapshot();
    expect(rows).toHaveLength(100);
    expect(rows[0]!.id).toBe("s119");
    expect(rows.at(-1)!.id).toBe("s20");
    expect(sessions.ordered()).toHaveLength(30);
    expect(sessions.ordered()[29]!.thread.threadId).toBe("s90");
  });

  it("can still switch to a session beyond what the model sees", () => {
    const { sessions } = make();
    for (let i = 0; i < 60; i++) sessions.observe(at(`s${i}`, "idle", i), "p");
    sessions.initialized = true;
    expect(sessions.select("s35")).toBe(true);
    expect(sessions.current).toBe("s35");
  });
});

describe("the current session", () => {
  it("changes only on an explicit switch, and survives a restart", async () => {
    const store = new MemoryStore();
    const llm = new ScriptedLlm(
      { action: "select", session: "改文档" },
      { action: "send", message: "补单测" },
      { action: "send", session: "网关", message: "顺便看下日志" }, // one-off to another session
      { action: "send", message: "再跑一遍" },
    );
    const { sessions, t3 } = make({ store, llm });
    twoSessions(sessions);
    for (const utterance of ["切到改文档", "补单测", "给网关说顺便看下日志", "再跑一遍"])
      await sessions.handle(utterance);
    expect(t3.sent.map(([t, m]) => [t, m])).toEqual([
      ["t2", "补单测"],
      ["t1", "顺便看下日志"],
      ["t2", "再跑一遍"],
    ]);
    expect(sessions.current).toBe("t2");
    expect(make({ store }).sessions.current).toBe("t2");
  });

  it("is cleared when its thread disappears", async () => {
    const store = new MemoryStore();
    store.json = JSON.stringify({ current: "gone" });
    const { sessions, speaker } = make({ store, llm: new FakeLlm({ action: "current" }) });
    await sessions.poll();
    await sessions.handle("现在是哪个");
    expect(sessions.current).toBeNull();
    expect(speaker.said).toEqual(["还没有当前 session。说“切到”加名字选一个。"]);
  });

  it("is listed in the snapshot and switched by select", () => {
    const { sessions } = make({ store: new MemoryStore() });
    twoSessions(sessions);
    sessions.setCurrent("t1");
    sessions.notify(tracked(sessions, "t2"), "改文档做完了。");
    const rows = new Map(sessions.snapshot().map((row) => [row.id, row]));
    expect(rows.get("t1")).toMatchObject({ current: true, name: "网关" });
    expect(rows.get("t2")).toMatchObject({ unread: 1, statusText: "空闲" });
    expect(sessions.select("t2")).toBe(true);
    expect(sessions.select("gone")).toBe(false);
    expect(sessions.current).toBe("t2");
  });

  it("lends itself to the session whose news the user replies to", async () => {
    const { sessions, speaker, t3 } = make({
      store: new MemoryStore(),
      llm: new ScriptedLlm({ action: "select", session: "改文档" }),
    });
    twoSessions(sessions);
    sessions.setCurrent("t1");
    sessions.awaiting.add("t2");
    sessions.notify(tracked(sessions, "t2"), "改文档做完了。要不要发版？"); // spoken: the user messaged it
    const followup = speaker.followups.at(-1)!;
    expect(followup).toBe("t2");
    await sessions.handle("发吧，顺便打个 tag", followup);
    expect(t3.sent).toEqual([["t2", "发吧，顺便打个 tag", "auto"]]);
    expect(sessions.current).toBe("t1"); // the reply didn't switch
    await sessions.handle("切到改文档", followup);
    expect(sessions.current).toBe("t2"); // a real switch sticks
  });
});

describe("answering", () => {
  it("sends an answer to the waiting session", async () => {
    const { sessions, speaker, t3 } = make({
      llm: new FakeLlm({ action: "answer", message: "选第一个" }),
    });
    sessions.observe(docs("running"), "yongheng");
    sessions.observe(thread("waiting"), "yongheng");
    tracked(sessions, "t1").questionPending = true;
    sessions.initialized = true;
    await sessions.handle("选第一个");
    expect(t3.sent).toEqual([["t1", "选第一个", "auto"]]);
    expect(speaker.said).toEqual(["<sent>"]); // it became the current session: a tone, no words
    expect(sessions.current).toBe("t1");
  });

  it("says so when no session is waiting", async () => {
    const { sessions, speaker, t3 } = make({
      llm: new FakeLlm({ action: "answer", message: "选第一个" }),
    });
    sessions.observe(docs("running"), "yongheng");
    sessions.initialized = true;
    await sessions.handle("选第一个");
    expect(t3.sent).toEqual([]);
    expect(speaker.said).toEqual(["现在没有 session 在等你回答。"]);
  });

  it("prefers the current session when several are waiting", async () => {
    const { sessions, t3 } = make({ llm: new FakeLlm({ action: "answer", message: "选第一个" }) });
    twoSessions(sessions);
    for (const t of sessions.tracked.values()) t.questionPending = true;
    sessions.current = "t2";
    await sessions.handle("选第一个");
    expect(t3.sent.map(([t]) => t)).toEqual(["t2"]);
  });

  const threeQuestions = [
    {
      requestId: "r1",
      questions: [
        { question: "日志级别用哪个？", options: [{ label: "info" }, { label: "debug" }] },
        { question: "要不要一起上 prod？", options: [{ label: "上" }, { label: "不上" }] },
        { question: "旧配置删掉吗？" },
      ],
    },
  ];

  function quizzing(llm: VoiceLlm) {
    const t3 = new FakeT3();
    t3.questions = threeQuestions;
    const made = make({ t3, llm });
    twoSessions(made.sessions);
    made.sessions.current = "t1";
    tracked(made.sessions, "t1").thread = thread("waiting", "r1", {
      pendingRequest: { id: "r1", kind: "user_input" },
    });
    return made;
  }

  it("asks several questions one by one and sends the answers together", async () => {
    const { sessions, speaker, t3 } = quizzing(new ScriptedLlm({ action: "inbox" }));
    await sessions.checkRequest("t1");
    await sessions.handle("用 info 吧");
    await sessions.handle("听通知"); // a command in between still works
    await sessions.handle("先不上 prod");
    await sessions.handle("删掉");
    expect(speaker.said).toEqual([
      "网关在等你回答。一共 3 个问题，答完一个我接着问下一个。第 1 个：日志级别用哪个？ 选项：info、debug。",
      "第 2 个：要不要一起上 prod？ 选项：上、不上。",
      "没有新通知。",
      "第 3 个：旧配置删掉吗？",
      "<sent>",
    ]);
    expect(t3.sent).toHaveLength(1);
    expect(t3.sent[0]![1]).toContain(
      "1. 日志级别用哪个？ 选项：info、debug。\n   回答：用 info 吧",
    );
    expect(t3.sent[0]![1]).toContain("3. 旧配置删掉吗？\n   回答：删掉");
  });

  it("sends what was answered when the user stops midway", async () => {
    const { sessions, speaker, t3 } = quizzing(new FakeLlm());
    await sessions.checkRequest("t1");
    await sessions.handle("用 debug");
    await sessions.handle("先不回答");
    expect(t3.sent[0]![1]).toMatch(/^先回答这几个，剩下的以后再说：\n1\. 日志级别用哪个？/);
    expect(t3.sent[0]![1]).not.toContain("2.");
    expect(sessions.quiz.size).toBe(0);
    expect(speaker.said.at(-1)).toBe("<sent>");
  });

  it("turns a reply listing several questions into a quiz", async () => {
    const llm = new FakeLlm();
    llm.summarize = async () => "改好了。日志级别用 info 还是 debug？还有 1 个问题。";
    const t3 = new FakeT3();
    t3.reply = "改好了。\n日志级别用 info 还是 debug？\n要不要上 prod？";
    const { sessions, speaker } = make({ t3, llm });
    sessions.observe(thread("running"), "yongheng");
    sessions.initialized = true;
    sessions.observe(thread("completed"), "yongheng");
    await sessions.settled();
    expect(speaker.said).toEqual([
      "网关做完了。改好了。日志级别用 info 还是 debug？一共 2 个问题，你答完一个我接着问下一个。",
    ]);
    expect(sessions.quiz.get("t1")?.questions).toEqual([
      "日志级别用 info 还是 debug？",
      "要不要上 prod？",
    ]);
  });
});

describe("commands", () => {
  it("beeps for the current session and says the name for others", async () => {
    const llm = new ScriptedLlm(
      { action: "send", message: "补单测" },
      { action: "send", session: "改文档", message: "看下日志" },
    );
    const { sessions, speaker } = make({ llm });
    twoSessions(sessions);
    sessions.current = "t1";
    await sessions.handle("补单测");
    await sessions.handle("给改文档说看下日志");
    expect(speaker.said).toEqual(["<sent>", "发给改文档了。"]);
  });

  it("sends plain talk to the current session without the LLM", async () => {
    const { sessions, speaker, t3 } = make({ llm: new NoLlm() });
    twoSessions(sessions);
    sessions.current = "t1";
    await sessions.handle("把重试改成指数退避，再补两个单测");
    sessions.lastNews = "网关做完了。测试都过了。";
    await sessions.handle("重播。");
    expect(t3.sent).toEqual([["t1", "把重试改成指数退避，再补两个单测", "auto"]]);
    expect(t3.raw[0]!.endsWith(VOICE_NOTE)).toBe(true); // the agent is told it's speech
    expect(speaker.said).toEqual(["<sent>", "网关做完了。测试都过了。"]);
  });

  it("still asks the LLM about commands and named sessions", () => {
    const { sessions } = make();
    twoSessions(sessions);
    sessions.current = "t1";
    const fast = (utterance: string) => sessions.fastIntent(utterance, sessions.ordered(), 1);
    for (const utterance of [
      "切到改文档",
      "听通知",
      "给改文档说看下日志",
      "改文档怎么样了",
      "打开被动模式",
      "停一下",
      "现在是哪个",
      "网关那边日志看下",
      "好的",
      "批准吧，执行",
    ]) {
      expect(fast(utterance), utterance).toBeNull();
    }
    expect(fast("现在那个 session 跑得怎么样了啊，有没有什么新进展")).toBeNull();
    tracked(sessions, "t2").questionPending = true; // someone waits for an answer
    expect(fast("用默认的配置就行吧")).toBeNull();
  });

  it("takes the fast path for long talk that mentions command words late", () => {
    const { sessions } = make();
    twoSessions(sessions);
    sessions.current = "t1";
    const fast = (utterance: string) => sessions.fastIntent(utterance, sessions.ordered(), 1);
    expect(fast("现在有一个问题，就是背景有杂音的时候，你会不会判断我已经说话停止了")?.action).toBe(
      "send",
    );
    expect(fast("打开被动模式，别再主动给我播报了，等我问了再说吧")).toBeNull();
    expect(fast("我觉得刚才发给改文档的那句话可能说错了，你帮我确认一下")).toBeNull();
  });

  it("matches session names with one misheard character", () => {
    expect(mentions("现在数据生成这个怎么样", "数据生产")).toBe(true);
    expect(mentions("把数据库表清一下然后重新生成", "数据生产")).toBe(false); // only "数据" in common
    expect(mentions("网页打不开", "网关")).toBe(false); // short names: exact only
  });

  it("replays the last content, not prompts, also after a restart", async () => {
    const store = new MemoryStore();
    const { sessions, speaker } = make({
      store,
      llm: new ScriptedLlm({ action: "none", reply: "你说了个“说”，是想让我做什么？" }),
    });
    twoSessions(sessions);
    sessions.replay();
    sessions.notify(tracked(sessions, "t1"), "网关做完了。"); // no current session: spoken
    await sessions.handle("说"); // one character: cut off, not sent to the LLM
    await sessions.handle("嗯说点什么"); // the LLM asks back: a prompt
    sessions.replay();
    expect(speaker.said).toEqual([
      "还没有可以重播的内容。",
      "网关做完了。",
      "没听清，等“嘀”一声再说。",
      "你说了个“说”，是想让我做什么？",
      "网关做完了。",
    ]);
    const restarted = make({ store });
    restarted.sessions.replay();
    expect(restarted.speaker.said).toEqual(["网关做完了。"]);
  });

  it("undoes the last message: stops the session and takes it back", async () => {
    const { sessions, speaker, t3 } = make({ llm: new NoLlm() });
    twoSessions(sessions);
    sessions.current = "t1";
    await sessions.handle("把数据库表全部删掉重建一遍");
    await sessions.handle("撤回");
    await sessions.handle("撤回");
    expect(t3.sent[0]).toEqual(["t1", "把数据库表全部删掉重建一遍", "auto"]);
    expect(t3.sent[1]).toEqual(["t1", "<interrupt>", null]);
    expect(t3.sent[2]![0]).toBe("t1");
    expect(t3.sent[2]![1]).toContain("请忽略我上一条消息“把数据库表全部删掉重建一遍”");
    expect(speaker.said).toEqual([
      "<sent>",
      "撤回了，已经让网关停下并忽略那句。",
      "没有可以撤回的。",
    ]);
  });

  it("names a session by voice, kept across a restart", async () => {
    const store = new MemoryStore();
    const { sessions, speaker } = make({
      store,
      llm: new ScriptedLlm({ action: "alias", session: "改文档", message: "“文档”" }),
    });
    twoSessions(sessions);
    await sessions.handle("把改文档那个叫文档");
    expect(speaker.said).toEqual(["好，以后改文档就叫文档。"]);
    const restarted = make({ store }).sessions;
    twoSessions(restarted);
    expect(restarted.name(tracked(restarted, "t2"))).toBe("文档");
    expect(restarted.hotwords()).toContain("文档");
  });

  it("opens a new session in the named or current project", async () => {
    class LaunchT3 extends FakeT3 {
      override async projects() {
        return [
          { id: "p1", title: "yongheng" },
          { id: "p9", title: "docs" },
        ];
      }
      override async threads() {
        const fresh = this.launched.map(([p, task], i) =>
          thread("running", null, {
            threadId: `new${i + 1}`,
            projectId: p,
            title: task,
            itemCount: 1,
          }),
        );
        return [thread("idle"), docs(), ...fresh];
      }
    }
    const llm = new ScriptedLlm(
      { action: "new", message: "查一下 prod 的日志", project: null },
      { action: "new", message: "补文档", project: "Docs" },
      { action: "new", message: "", project: null },
    );
    const { sessions, speaker, t3 } = make({ t3: new LaunchT3(), llm });
    await sessions.poll();
    sessions.current = "t1";
    await sessions.handle("新开一个，查一下 prod 的日志");
    expect(sessions.current).toBe("new1");
    await sessions.handle("在 docs 里新开一个，补文档");
    await sessions.handle("新开一个");
    expect(t3.launched).toEqual([
      ["p1", "查一下 prod 的日志", "full-access"],
      ["p9", "补文档", "full-access"],
    ]);
    expect(speaker.said.slice(0, 2)).toEqual([
      "在yongheng开好了，已经开始做了。",
      "在docs开好了，已经开始做了。",
    ]);
    expect(speaker.said[2]).toMatch(/^新 session 要做什么？/);
  });

  it("reports a session's status with a summary of its last exchange", async () => {
    const t3 = new FakeT3();
    t3.reply = "7 题已全部并发开跑，预计 1 到 3.5 小时。";
    const { sessions, speaker } = make({
      t3,
      llm: new ScriptedLlm(
        { action: "status", session: "改文档" },
        { action: "status", session: "网关" },
      ),
    });
    twoSessions(sessions);
    tracked(sessions, "t2").thread = docs("completed");
    tracked(sessions, "t1").thread = thread("running");
    await sessions.handle("改文档怎么样了");
    await sessions.handle("网关怎么样了");
    expect(speaker.said).toEqual([
      "改文档已完成。7 题已全部并发开跑，预计 1 到 3.5 小时。",
      "网关正在跑，上一轮说的是：7 题已全部并发开跑，预计 1 到 3.5 小时。",
    ]);
    expect(speaker.followups).toEqual(["t2", "t1"]); // the user can answer right after hearing it
  });

  it("reads replies in full in detail mode, kept across a restart", async () => {
    const store = new MemoryStore();
    const t3 = new FakeT3();
    t3.reply = "改了三个文件，测试都过了。";
    const llm = new ScriptedLlm(
      { action: "detail", message: "on" },
      { action: "status", session: "网关" },
      { action: "detail", message: "off" },
    );
    const { sessions, speaker } = make({ store, t3, llm });
    twoSessions(sessions);
    await sessions.handle("详细模式");
    await sessions.handle("网关怎么样了");
    expect(make({ store }).sessions.detailed).toBe(true);
    await sessions.handle("简洁模式");
    expect(speaker.said).toEqual([
      "详细模式开了，回复基本照原文念。",
      "网关空闲。【详细】改了三个文件，测试都过了。",
      "切回简洁模式了。",
    ]);
    expect(sessions.detailed).toBe(false);
  });
});

describe("speakable", () => {
  it("strips markdown that sounds bad read aloud", () => {
    const text = speakable("## 结果\n改了 `a.py`，见 [PR](http://x)\n```py\nprint(1)\n```");
    expect(text).not.toMatch(/`|http|print/);
  });
});
