// @effect-diagnostics globalDate:off - plain-TS voice core, tested without an Effect runtime.
/**
 * The voice assistant's brain: tracks threads, announces when one finishes or needs
 * an answer, and turns what the user says into commands. Plain TypeScript behind small
 * ports (T3, LLM, speaker, state) so it is tested like the Python voice-pilot it was.
 */
import type { VoiceConfig } from "./config.ts";
import type { Intent, SessionListing, VoiceLlm } from "./llm.ts";
import type { SpeakerPort } from "./speaker.ts";

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
]);

/** Sessions the app lists, and the fewer given to the language model with each utterance. */
const SESSIONS_SHOWN = 100;
const SESSIONS_LISTED = 30;

export interface VoiceThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  /** activityRunStatus ?? status, as the MCP tools report it. */
  readonly status: string;
  readonly latestRunId: string | null;
  readonly itemCount: number;
  readonly pendingRequest: { readonly id: string; readonly kind: string } | null;
  /** Last activity, in epoch milliseconds; sessions without one count as oldest. */
  readonly updatedAt?: number;
  /** Which computer it runs on, when the brain watches several. */
  readonly computer?: string;
}

/** What the brain needs from the environment; in-process in production, faked in tests. */
export interface VoiceT3 {
  projects(): Promise<ReadonlyArray<{ readonly id: string; readonly title: string }>>;
  /** Every live top-level thread (not archived, not a subagent's). */
  threads(): Promise<ReadonlyArray<VoiceThread>>;
  send(threadId: string, text: string, mode: VoiceConfig["sendMode"]): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  /** The newest assistant reply and the user message that started its run. */
  lastExchange(
    threadId: string,
  ): Promise<{ readonly asked: string | null; readonly text: string | null }>;
  /** Questions of the thread's pending user-input request, as T3 stores them. */
  pendingQuestions(threadId: string): Promise<ReadonlyArray<unknown>>;
  respondToApproval(
    threadId: string,
    requestId: string,
    decision: "accept" | "decline",
  ): Promise<void>;
  launch(
    projectId: string,
    message: string,
    runtimeMode: VoiceConfig["newSessionMode"],
  ): Promise<{ readonly threadId: string | null }>;
}

export class T3Error extends Error {}

export interface VoiceState {
  readonly current?: string | null;
  readonly passive?: boolean;
  readonly detailed?: boolean;
  readonly lastNews?: string | null;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly inbox?: ReadonlyArray<Notice>;
}

export interface VoiceStateStore {
  load(): VoiceState;
  save(state: VoiceState): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
}

// Sent along with every spoken message: recognition gets homophones wrong ("会话" heard
// as "绘画"), and the agent should read for meaning; the user listens, so one question.
export const VOICE_NOTE =
  "\n\n（语音输入，可能有同音错字，请按意思理解。我是听你的回复，要问我问题的话一次只问一个。）";

const QUIZ_STOP = /^(不用问了|先不回答|先不答了|不回答了|取消回答|先答到这)[。！!，,\s]*$/u;
const MORE_QUESTIONS = /还有\s*\d+\s*个问题[^。]*。?/u;
const UNDO =
  /^(撤回|撤销|撤回刚才那句|撤回上一条|刚才那句不对|刚才说错了|取消刚才那条)[。！!，,\s]*$/u;
const REPLAY =
  /^(重播|重新播放|再播一遍|再播一次|再说一遍|再说一次|没听清|刚才说的?(啥|什么))[。！!？?，,\s]*$/u;
// Fast path: plain talk goes to the current session without the LLM (saves 1.5-2 s).
// Anything that may be a command, or that names a session, still goes to it.
const COMMANDISH = new RegExp(
  "(给|对|跟|告诉|和).{0,12}(说|讲|发|问)|切到|切换|换成|换到|通知|状态|进度|怎么样|在干嘛|干嘛呢|" +
    "做完了?吗|停|中断|暂停|有哪些|列出|列表|被动|主动|当前|哪个|重播|再说|再播|念|没听清|撤回|撤销|说错了|" +
    "起个名|叫做|改名|新开|开个新|开一个新|新建|详细|简洁|简短|批准|同意|拒绝|允许|session|会话",
  "iu",
);
const NOT_WORD = /[\p{P}\p{S}\s]/gu;

const STATUS_WORDS: Readonly<Record<string, string>> = {
  idle: "空闲",
  preparing: "准备中",
  queued: "排队中",
  starting: "启动中",
  running: "正在跑",
  waiting: "在等你回答",
  completed: "已完成",
  interrupted: "已中断",
  failed: "失败了",
  cancelled: "已取消",
  rolled_back: "已回滚",
};

const APPROVAL_WORDS: Readonly<Record<string, string>> = {
  command: "执行一条命令",
  "file-read": "读取文件",
  "file-change": "修改文件",
  "mcp-elicitation": "一个工具请求",
  permission: "一项权限",
};

export interface Tracked {
  thread: VoiceThread;
  project: string;
  /** (run id, item count) of the last request announced; a later one in the same run differs. */
  announcedRequest: string | null;
  questionPending: boolean;
}

interface Quiz {
  readonly questions: ReadonlyArray<string>;
  readonly answers: Array<string>;
}

export interface Notice {
  readonly threadId: string;
  text: string;
  /** Already mentioned in an "xx 有新通知" line. */
  hinted: boolean;
  /** The separate announcements merged into this one notice. */
  parts: Array<string>;
}

export interface SessionRow {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly project: string;
  readonly status: string;
  readonly statusText: string;
  readonly current: boolean;
  readonly unread: number;
  readonly computer?: string;
}

const NOT_BORROWED = Symbol("not borrowed");

export interface SessionsDeps {
  readonly config: () => VoiceConfig;
  readonly t3: VoiceT3;
  readonly llm: VoiceLlm;
  readonly speaker: SpeakerPort;
  readonly store?: VoiceStateStore;
  readonly logger?: Logger;
  /** Seconds since the epoch; injectable so tests control "five minutes later". */
  readonly now?: () => number;
}

export class Sessions {
  static readonly CHIME_EVERY = 10; // several notices at once chime once
  static readonly HINT_EVERY = 300; // seconds before the same session is mentioned again
  static readonly UNDO_WINDOW = 1800; // seconds a sent message can still be taken back
  static readonly FIXED_LINES = [
    "没有新通知。",
    "没听清，等“嘀”一声再说。",
    "还没有可以重播的内容。",
    "没有可以撤回的。",
    "现在没有在问的问题。",
    "好，先不问了。",
    "切回主动模式了。",
    "现在没有在跑的 session。",
    "现在没有 session 在等你回答。",
    "新 session 要做什么？",
    "没听清。",
  ];

  private readonly t3: VoiceT3;
  private readonly llm: VoiceLlm;
  private readonly speaker: SpeakerPort;
  private readonly config: () => VoiceConfig;
  private readonly store: VoiceStateStore | undefined;
  private readonly logger: Logger;
  private readonly now: () => number;

  readonly tracked = new Map<string, Tracked>();
  private projects = new Map<string, string>();
  private projectsAt = 0;
  /** Set after the first pass: threads seen before it are not news. */
  initialized = false;
  private checking = new Set<string>();
  private background = new Set<Promise<unknown>>();
  private polling: Promise<void> | null = null;

  /** Thread commands go to when none is named; only "切到 xx" changes it. */
  current: string | null = null;
  /** Passive mode: nothing announced on its own; it all waits in the inbox. */
  passive = false;
  /** Detail mode: replies read nearly in full instead of summarized. */
  detailed = false;
  /** Last announcement with content, for "重播" (not prompts or confirmations). */
  lastNews: string | null = null;
  /** Names given by voice: alias → thread id. */
  private aliases: Record<string, string> = {};
  inbox: Array<Notice> = [];
  private lastSent: { threadId: string; message: string; at: number } | null = null;
  /** Name of the session the last utterance went to, for the log. */
  lastTarget: string | null = null;
  readonly quiz = new Map<string, Quiz>();
  /** While a follow-up reply is handled, `current` is lent to the session it answers. */
  private borrowedFrom: string | null | typeof NOT_BORROWED = NOT_BORROWED;
  /** Sessions the user just spoke to: their next news is the awaited reply. */
  readonly awaiting = new Set<string>();
  readonly mentionedAt = new Map<string, number>();
  private chimedAt = 0;

  constructor(deps: SessionsDeps) {
    this.t3 = deps.t3;
    this.llm = deps.llm;
    this.speaker = deps.speaker;
    this.config = deps.config;
    this.store = deps.store;
    this.logger = deps.logger ?? { info: () => {}, warn: () => {} };
    this.now = deps.now ?? (() => Date.now() / 1000);
    this.restore();
  }

  private restore(): void {
    let state: VoiceState = {};
    try {
      state = this.store?.load() ?? {};
    } catch (error) {
      this.logger.warn("voice: reading saved state failed", error);
    }
    this.current = state.current ?? null;
    this.passive = state.passive ?? false;
    this.detailed = state.detailed ?? false;
    this.lastNews = state.lastNews ?? null;
    this.aliases = { ...state.aliases };
    this.inbox = Sessions.trim(
      (state.inbox ?? []).map((n) => ({ ...n, parts: [...(n.parts ?? [])] })),
    );
  }

  private save(): void {
    if (!this.store) return;
    const current = this.borrowedFrom === NOT_BORROWED ? this.current : this.borrowedFrom;
    try {
      this.store.save({
        current,
        passive: this.passive,
        detailed: this.detailed,
        lastNews: this.lastNews,
        aliases: this.aliases,
        inbox: this.inbox,
      });
    } catch (error) {
      this.logger.warn("voice: saving state failed", error);
    }
  }

  /** Background work (announcements, question checks, merges); tests await it. */
  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((error) =>
      this.logger.warn("voice background task failed", error),
    );
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.all(this.background);
  }

  setCurrent(threadId: string | null): void {
    this.current = threadId;
    this.borrowedFrom = NOT_BORROWED; // a real switch ends any follow-up borrowing
    this.save();
  }

  aliasesFor(tracked: Tracked): Array<string> {
    const spoken = Object.entries(this.aliases)
      .filter(([, id]) => id === tracked.thread.threadId)
      .map(([alias]) => alias);
    const haystack =
      `${tracked.thread.title} ${tracked.project} ${tracked.thread.threadId}`.toLowerCase();
    const configured = Object.entries(this.config().aliases)
      .filter(([, match]) => haystack.includes(match.toLowerCase()))
      .map(([alias]) => alias);
    return [...spoken, ...configured];
  }

  name(tracked: Tracked): string {
    const alias = this.aliasesFor(tracked)[0];
    if (alias) return alias;
    const base = this.baseName(tracked);
    const computer = tracked.thread.computer;
    if (!computer) return base;
    // The computer is only said when another computer has a session that sounds the same.
    for (const other of this.tracked.values()) {
      if (
        other !== tracked &&
        other.thread.computer !== undefined &&
        other.thread.computer !== computer &&
        this.aliasesFor(other).length === 0 &&
        this.baseName(other) === base
      )
        return `${computer}的${base}`;
    }
    return base;
  }

  private baseName(tracked: Tracked): string {
    const title =
      tracked.thread.title
        .replace(/[`*_#>[\]()]/g, "")
        .trim()
        .split(/[，。,.!?！？\n]/u)[0] ?? "";
    return [...title].slice(0, 14).join("") || tracked.project;
  }

  private nameOf(threadId: string): string {
    const tracked = this.tracked.get(threadId);
    return tracked ? this.name(tracked) : "一个已经关掉的 session";
  }

  /** Words for the recognizer to favor: aliases, then names of current/active sessions. */
  hotwords(budget = 80): Array<string> {
    const words = Object.keys(this.config().aliases);
    for (const tracked of this.ordered()) words.push(this.name(tracked), tracked.project);
    const picked: Array<string> = [];
    let used = 0;
    // Doubao caps a hotword at 10 Chinese characters; a cut-off word would mislead it.
    for (const word of new Set(
      words.map((w) => w.trim()).filter((w) => w.length > 0 && w.length <= 10),
    )) {
      if (used + word.length > budget) break;
      picked.push(word);
      used += word.length;
    }
    return picked;
  }

  snapshot(): Array<SessionRow> {
    const unread = new Map<string, number>();
    for (const notice of this.inbox)
      unread.set(notice.threadId, (unread.get(notice.threadId) ?? 0) + 1);
    return this.ordered(SESSIONS_SHOWN).map((t) => ({
      id: t.thread.threadId,
      name: this.name(t),
      title: t.thread.title,
      project: t.project,
      status: t.thread.status,
      statusText: STATUS_WORDS[t.thread.status] ?? t.thread.status,
      current: t.thread.threadId === this.current,
      unread: unread.get(t.thread.threadId) ?? 0,
      ...(t.thread.computer === undefined ? {} : { computer: t.thread.computer }),
    }));
  }

  select(threadId: string): boolean {
    if (!this.tracked.has(threadId)) return false;
    this.setCurrent(threadId);
    return true;
  }

  /** Short lines said again and again, worth having in the TTS cache before first use. */
  commonLines(): Array<string> {
    const lines = [...Sessions.FIXED_LINES];
    for (const tracked of this.ordered().slice(0, 12)) {
      const name = this.name(tracked);
      lines.push(`${name}有新通知。`, `切到${name}了。`, `发给${name}了。`, `回答发给${name}了。`);
    }
    return lines;
  }

  describeCurrent(): string {
    const current = this.current ? this.tracked.get(this.current) : undefined;
    if (!current) return "还没有当前 session。说“切到”加名字选一个。";
    return `当前是${this.name(current)}，${STATUS_WORDS[current.thread.status] ?? current.thread.status}。`;
  }

  private async refreshProjects(): Promise<void> {
    if (this.now() - this.projectsAt < 60 && this.projects.size > 0) return;
    this.projects = new Map((await this.t3.projects()).map((p) => [p.id, p.title]));
    this.projectsAt = this.now();
  }

  /** One pass over all threads; concurrent calls share the pass in flight. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => (this.polling = null));
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    await this.refreshProjects();
    const seen = new Set<string>();
    for (const thread of await this.t3.threads()) {
      const project = this.projects.get(thread.projectId);
      if (project === undefined) continue;
      seen.add(thread.threadId);
      this.observe(thread, project);
    }
    for (const threadId of this.tracked.keys())
      if (!seen.has(threadId)) this.tracked.delete(threadId);
    if (this.current && !this.tracked.has(this.current)) {
      this.logger.info("current voice session is gone (deleted or archived); clearing it");
      this.setCurrent(null);
    }
    this.initialized = true;
  }

  observe(thread: VoiceThread, project: string): void {
    const previous = this.tracked.get(thread.threadId);
    const tracked: Tracked = {
      thread,
      project,
      announcedRequest: previous?.announcedRequest ?? null,
      questionPending: previous?.questionPending ?? false,
    };
    this.tracked.set(thread.threadId, tracked);
    if (!this.initialized || !previous) return;
    const old = previous.thread;
    const finished = !ACTIVE_STATUSES.has(thread.status) && thread.status !== "waiting";
    // A run that started and ended between two passes only shows up as a new run id.
    const ran =
      ACTIVE_STATUSES.has(old.status) ||
      old.status === "waiting" ||
      old.latestRunId !== thread.latestRunId;
    if (finished && ran && thread.latestRunId) this.track(this.announceFinish(tracked));
    if (thread.pendingRequest) this.spawnRequestCheck(thread.threadId);
    else tracked.questionPending = false;
  }

  private spawnRequestCheck(threadId: string): void {
    if (this.checking.has(threadId)) return;
    this.checking.add(threadId);
    this.track(this.checkRequest(threadId).finally(() => this.checking.delete(threadId)));
  }

  private async announceFinish(tracked: Tracked): Promise<void> {
    // The current session goes without its name: the user knows which one it is.
    const name = tracked.thread.threadId === this.current ? "" : this.name(tracked);
    const status = tracked.thread.status;
    try {
      if (status === "completed") {
        const { asked, text } = await this.t3.lastExchange(tracked.thread.threadId);
        let summary = text
          ? await this.llm.summarize(text, asked, { detailed: this.detailed })
          : "没有留下回复。";
        if (summary === "SKIP") {
          this.logger.info(
            `voice: skipped an announcement with no news from ${this.name(tracked)}`,
          );
          return;
        }
        if (text && MORE_QUESTIONS.test(summary)) {
          const questions = await this.llm.extractQuestions(text);
          if (questions.length >= 2) {
            this.quiz.set(tracked.thread.threadId, { questions, answers: [] });
            summary = summary.replace(
              MORE_QUESTIONS,
              `一共 ${questions.length} 个问题，你答完一个我接着问下一个。`,
            );
          }
        }
        this.notify(tracked, `${name}做完了。${summary}`);
      } else if (status === "failed") {
        this.notify(tracked, `${name}失败了，去 T3 里看一下。`);
      } else if (status === "interrupted" || status === "cancelled") {
        this.notify(tracked, `${name}已经停了。`);
      }
    } catch (error) {
      this.logger.warn("voice announcement failed", error);
      this.notify(tracked, `${name}做完了，但我没读到它的回复：${errorMessage(error)}`);
    }
  }

  async checkRequest(threadId: string): Promise<void> {
    const tracked = this.tracked.get(threadId);
    const request = tracked?.thread.pendingRequest;
    if (!tracked || !request) return;
    const key = `${request.id}`;
    if (tracked.announcedRequest === key) return;
    tracked.announcedRequest = key;
    if (request.kind !== "user_input") {
      tracked.questionPending = false;
      const what = APPROVAL_WORDS[request.kind];
      this.notify(
        tracked,
        what
          ? `${this.name(tracked)}在等你批准${what}。说“批准”或者“拒绝”。`
          : `${this.name(tracked)}在等你处理一个请求，语音处理不了，去 T3 里看一下。`,
      );
      return;
    }
    let questions: ReadonlyArray<unknown> = [];
    try {
      questions = await this.t3.pendingQuestions(threadId);
    } catch (error) {
      this.logger.warn("voice: reading pending questions failed", error);
    }
    const current = this.tracked.get(threadId) ?? tracked; // passes replace the object while we wait
    current.questionPending = questions.length > 0;
    current.announcedRequest = key;
    if (questions.length === 0) return;
    const spoken = spokenQuestions(questions);
    let question: string;
    if (spoken.length >= 2) {
      this.quiz.set(threadId, { questions: spoken, answers: [] });
      question = `一共 ${spoken.length} 个问题，答完一个我接着问下一个。第 1 个：${spoken[0]}`;
    } else {
      question = await this.llm.readQuestion(JSON.stringify(questions));
    }
    this.notify(current, `${this.name(current)}在等你回答。${question}`);
  }

  /**
   * Speak news from the current session, one just spoken to, or any when none is
   * current. Other sessions' news waits in the inbox, mentioned by name only.
   */
  notify(tracked: Tracked, text: string): void {
    const threadId = tracked.thread.threadId;
    if (
      !this.passive &&
      (this.config().announceAll === true ||
        this.current === null ||
        threadId === this.current ||
        this.awaiting.has(threadId))
    ) {
      this.awaiting.delete(threadId);
      this.news(text, { followup: threadId });
    } else {
      this.keep(threadId, text);
    }
    if (!this.passive) this.hintInbox();
    else if (this.now() - this.chimedAt > Sessions.CHIME_EVERY) {
      this.chimedAt = this.now();
      this.speaker.cue("chime"); // passive: a tone, no words
    }
    this.save();
  }

  /** Put news in the inbox, merged into the session's unread notice if any. */
  private keep(threadId: string, text: string): void {
    const old = this.inbox.find((n) => n.threadId === threadId);
    if (!old) {
      this.inbox = Sessions.trim([
        ...this.inbox,
        { threadId, text, hinted: this.passive, parts: [text] },
      ]);
      return;
    }
    this.inbox = [...this.inbox.filter((n) => n !== old), old]; // newest last
    old.parts = [...(old.parts.length ? old.parts : [old.text]), text].slice(-4);
    old.text = text; // until the merged line is ready, the latest news stands in
    old.hinted = this.passive;
    if (this.detailed) {
      old.text = old.parts.join(" "); // nothing is cut in detail mode
      return;
    }
    this.track(this.compress(old, [...old.parts]));
  }

  private async compress(notice: Notice, parts: ReadonlyArray<string>): Promise<void> {
    const merged = await this.llm
      .mergeNotices(this.nameOf(notice.threadId), parts)
      .catch((error) => {
        this.logger.warn("voice: merging notices failed", error);
        return "";
      });
    const unchanged =
      notice.parts.length === parts.length && notice.parts.every((p, i) => p === parts[i]);
    if (merged && unchanged && this.inbox.includes(notice)) {
      notice.text = merged;
      this.save();
    }
  }

  /** One notice per session (the newest), 20 at most. */
  static trim(inbox: ReadonlyArray<Notice>): Array<Notice> {
    const kept: Array<Notice> = [];
    const seen = new Set<string>();
    for (const notice of [...inbox].reverse()) {
      if (seen.has(notice.threadId)) continue;
      seen.add(notice.threadId);
      kept.push(notice);
    }
    return kept.reverse().slice(-20);
  }

  setPassive(on: boolean): void {
    this.passive = on;
    this.save();
  }

  setDetailed(on: boolean): void {
    this.detailed = on;
    this.save();
  }

  private hintInbox(): void {
    // Each session at most once per HINT_EVERY: unread old notices must not silence
    // newer ones, and a busy session must not nag.
    const now = this.now();
    const fresh = new Set(this.inbox.filter((n) => !n.hinted).map((n) => n.threadId));
    const due = [...new Set(this.inbox.map((n) => n.threadId))].filter(
      (id) => fresh.has(id) && now - (this.mentionedAt.get(id) ?? 0) > Sessions.HINT_EVERY,
    );
    for (const notice of this.inbox) notice.hinted = true;
    if (due.length === 0) return;
    for (const id of due) this.mentionedAt.set(id, now);
    this.speaker.say(`${due.map((id) => this.nameOf(id)).join("、")}有新通知。`);
  }

  /** Delivered: a tone for the current session, words when it went to another one. */
  private confirm(target: Tracked, words: string): void {
    if (target.thread.threadId === this.current) this.speaker.cue("sent");
    else this.speaker.say(words, { urgent: true });
  }

  /** Say something with content and keep it for "重播". */
  private news(
    text: string,
    options?: { readonly urgent?: boolean; readonly followup?: string | null },
  ): void {
    this.lastNews = text;
    this.speaker.say(text, options);
    this.save();
  }

  private say(text: string): void {
    this.speaker.say(text, { urgent: true });
  }

  replay(): void {
    this.say(this.lastNews ?? "还没有可以重播的内容。");
  }

  /** Read out (and clear) the saved notices; also what a double press on the headset does. */
  readInbox(target: Tracked | null = null): void {
    const notices = this.inbox.filter(
      (n) => target === null || n.threadId === target.thread.threadId,
    );
    if (notices.length === 0) {
      this.say(target === null ? "没有新通知。" : `${this.name(target)}没有新通知。`);
      return;
    }
    this.inbox = this.inbox.filter((n) => !notices.includes(n));
    // A reply right after hearing one session's news goes to it; after several, to none.
    const only = new Set(notices.map((n) => n.threadId)).size === 1 ? notices[0]!.threadId : null;
    [...notices].reverse().forEach((notice, i) => {
      this.speaker.say(notice.text, { urgent: true, followup: i === 0 ? only : null }); // urgent: reverse keeps order
    });
    this.lastNews = notices.map((n) => n.text).join(" ");
    this.save();
  }

  /** Running or waiting first, then the current one, then the most recently active. */
  ordered(limit = SESSIONS_LISTED): Array<Tracked> {
    const rank = (t: Tracked) =>
      (ACTIVE_STATUSES.has(t.thread.status) || t.thread.status === "waiting" ? 0 : 2) +
      (t.thread.threadId === this.current ? 0 : 1);
    return [...this.tracked.values()]
      .sort((a, b) => rank(a) - rank(b) || (b.thread.updatedAt ?? 0) - (a.thread.updatedAt ?? 0))
      .slice(0, limit);
  }

  /** `followup`: said right after that session's news, so it stands in for the current one. */
  async handle(utterance: string, followup: string | null = null): Promise<void> {
    if (followup && this.tracked.has(followup) && followup !== this.current) {
      this.borrowedFrom = this.current;
      this.current = followup;
      try {
        await this.handleOne(utterance);
      } finally {
        const lender = this.borrowedFrom as string | null | typeof NOT_BORROWED; // setCurrent may have cleared it
        if (lender !== NOT_BORROWED) this.current = lender; // not switched meanwhile
        this.borrowedFrom = NOT_BORROWED;
      }
      return;
    }
    await this.handleOne(utterance);
  }

  private async handleOne(raw: string): Promise<void> {
    const utterance = raw.trim();
    if (!utterance) {
      this.say("没听清。");
      return;
    }
    this.lastTarget = null;
    if (wordLength(utterance) <= 1 && !(this.current && this.quiz.has(this.current))) {
      this.say("没听清，等“嘀”一声再说。"); // almost always the start was cut off
      return;
    }
    if (!this.initialized) await this.poll();
    const ordered = this.ordered();
    const currentIndex = ordered.findIndex((t) => t.thread.threadId === this.current) + 1 || null;
    let intent = this.fastIntent(utterance, ordered, currentIndex);
    if (!intent) {
      const listing: Array<SessionListing> = ordered.map((t, i) => ({
        index: i + 1,
        name: this.name(t),
        project: t.project,
        status: STATUS_WORDS[t.thread.status] ?? t.thread.status,
        aliases: this.aliasesFor(t),
      }));
      intent = await this.llm.parseIntent(utterance, listing, currentIndex, [
        ...this.projects.values(),
      ]);
    }
    let target = pick(ordered, intent.session);
    if (
      !target &&
      ["send", "read", "read_full", "stop"].includes(intent.action ?? "") &&
      this.current
    ) {
      target = this.tracked.get(this.current) ?? null;
    }
    try {
      await this.run(intent.action ?? "none", target, intent, ordered);
    } catch (error) {
      if (!(error instanceof T3Error)) throw error;
      this.say(`操作失败：${error.message}`);
    }
  }

  fastIntent(
    utterance: string,
    ordered: ReadonlyArray<Tracked>,
    currentIndex: number | null,
  ): Intent | null {
    if (REPLAY.test(utterance)) return { action: "repeat" };
    if (UNDO.test(utterance)) return { action: "undo" };
    if (this.quiz.size > 0 && QUIZ_STOP.test(utterance)) return { action: "quiz_stop" };
    if (
      this.current &&
      this.quiz.has(this.current) &&
      currentIndex !== null &&
      !COMMANDISH.test(utterance)
    ) {
      return { action: "send", session: currentIndex, message: utterance }; // the next answer, however short
    }
    const length = wordLength(utterance);
    // Commands are short and lead with the command word ("切到…", "听通知", "停一下"); a
    // long sentence that merely mentions "通知" or "停止" further in is just talk.
    if (currentIndex === null || length < 4) return null;
    if (COMMANDISH.test(length <= 20 ? utterance : [...utterance].slice(0, 12).join("")))
      return null;
    if (
      ordered.some(
        (t) =>
          t.questionPending ||
          t.thread.pendingRequest ||
          t.thread.status === "waiting" ||
          this.quiz.has(t.thread.threadId),
      )
    ) {
      return null; // might be an answer
    }
    if (/session|会话/iu.test(utterance)) return null;
    const lowered = utterance.toLowerCase();
    for (const t of ordered) {
      if (
        [this.name(t), t.project, ...this.aliasesFor(t)].some((n) =>
          mentions(lowered, n.toLowerCase()),
        )
      )
        return null;
    }
    return { action: "send", session: currentIndex, message: utterance };
  }

  private async run(
    action: string,
    target: Tracked | null,
    intent: Intent,
    ordered: ReadonlyArray<Tracked>,
  ): Promise<void> {
    const message = (intent.message ?? "").trim();
    if (["send", "select", "read", "read_full", "stop", "alias"].includes(action) && !target) {
      this.say(intent.reply || "是哪个 session？可以先说“切到”加名字，选一个当前 session。");
      return;
    }
    if (["send", "read", "read_full"].includes(action) && this.current === null && target) {
      this.setCurrent(target.thread.threadId); // first session addressed becomes current
    }
    switch (action) {
      case "send":
        if (!message) return this.say("要跟它说什么？");
        if (this.quiz.has(target!.thread.threadId)) return this.quizAnswer(target!, message);
        await this.deliver(target!, message);
        this.confirm(target!, `发给${this.name(target!)}了。`);
        return;
      case "answer": {
        let to = target;
        if (!to) {
          const waiting = ordered.filter(
            (t) =>
              t.questionPending ||
              t.thread.status === "waiting" ||
              this.quiz.has(t.thread.threadId),
          );
          if (waiting.length === 0) return this.say("现在没有 session 在等你回答。");
          const current = waiting.filter((t) => t.thread.threadId === this.current);
          if (waiting.length > 1 && current.length === 0)
            return this.say("有好几个 session 在等你回答，是哪个？");
          to = (current[0] ?? waiting[0])!;
        }
        if (!message) return this.say(`要回答${this.name(to)}什么？`);
        if (this.quiz.has(to.thread.threadId)) return this.quizAnswer(to, message);
        await this.deliver(to, message);
        if (!this.current) this.setCurrent(to.thread.threadId);
        this.confirm(to, `回答发给${this.name(to)}了。`);
        return;
      }
      case "approve":
        return this.approve(target, ordered, message === "decline" ? "decline" : "accept");
      case "select": {
        this.setCurrent(target!.thread.threadId);
        const unread = this.inbox.filter((n) => n.threadId === target!.thread.threadId).length;
        return this.say(
          `切到${this.name(target!)}了。${unread ? `它有 ${unread} 条新通知。` : ""}`,
        );
      }
      case "inbox":
        return this.readInbox(target);
      case "passive": {
        const on = !["off", "false", "关"].includes(message.toLowerCase());
        this.setPassive(on);
        const waiting = this.inbox.length
          ? `攒着 ${this.inbox.length} 条通知，说“听通知”就念。`
          : "";
        return this.say(
          on ? "被动模式开了，有进度不会主动播，想听就说“听通知”。" : `切回主动模式了。${waiting}`,
        );
      }
      case "detail": {
        const on = !["off", "false", "关"].includes(message.toLowerCase());
        this.setDetailed(on);
        return this.say(on ? "详细模式开了，回复基本照原文念。" : "切回简洁模式了。");
      }
      case "quiz_stop": {
        const threadId =
          this.current && this.quiz.has(this.current)
            ? this.current
            : ([...this.quiz.keys()][0] ?? null);
        const quiz = threadId ? this.quiz.get(threadId) : undefined;
        if (!threadId || !quiz) return this.say("现在没有在问的问题。");
        if (quiz.answers.length > 0 && this.tracked.has(threadId))
          return this.sendQuiz(this.tracked.get(threadId)!, true);
        this.quiz.delete(threadId);
        return this.say("好，先不问了。");
      }
      case "undo":
        return this.undo();
      case "new":
        return this.launch(intent);
      case "alias": {
        const alias = message.replace(/[\s“”"'。，,]/gu, "");
        if (alias.length < 1 || alias.length > 8) return this.say("新名字要一到八个字。");
        const old = this.name(target!);
        this.aliases = Object.fromEntries(
          Object.entries(this.aliases).filter(([a]) => a !== alias),
        );
        this.aliases[alias] = target!.thread.threadId;
        this.save();
        return this.say(`好，以后${old}就叫${alias}。`);
      }
      case "current":
        return this.say(this.describeCurrent());
      case "status": {
        if (target) return this.report(target);
        const active = ordered.filter(
          (t) => ACTIVE_STATUSES.has(t.thread.status) || t.thread.status === "waiting",
        );
        if (active.length === 0) return this.say("现在没有在跑的 session。");
        return this.news(
          `${active.map((t) => `${this.name(t)}${STATUS_WORDS[t.thread.status]}`).join("；")}。`,
          { urgent: true },
        );
      }
      case "read":
      case "read_full": {
        this.inbox = this.inbox.filter((n) => n.threadId !== target!.thread.threadId); // hearing it now
        this.save();
        const { asked, text } = await this.t3.lastExchange(target!.thread.threadId);
        if (!text) return this.say(`${this.name(target!)}还没有回复。`);
        if (action === "read_full") return this.news(speakable(text), { urgent: true });
        let summary = await this.llm.summarize(text, asked, { detailed: this.detailed });
        if (summary === "SKIP") summary = `没有新进展。${speakable(text, 80)}`; // asked for it
        return this.news(`${this.name(target!)}上一条回复说：${summary}`, { urgent: true });
      }
      case "stop":
        await this.t3.interrupt(target!.thread.threadId);
        return this.say(`已经让${this.name(target!)}停下。`);
      case "list":
        if (ordered.length === 0) return this.say("没有 session。");
        return this.say(
          `${ordered
            .slice(0, 8)
            .map((t, i) => `${i + 1}号${this.name(t)}`)
            .join("；")}。`,
        );
      case "repeat":
        return this.replay();
      default:
        return this.say(intent.reply || "没听懂，再说一遍？");
    }
  }

  private async deliver(target: Tracked, message: string): Promise<void> {
    await this.t3.send(target.thread.threadId, message + VOICE_NOTE, this.config().sendMode);
    this.awaiting.add(target.thread.threadId);
    this.lastSent = { threadId: target.thread.threadId, message, at: this.now() };
    this.lastTarget = this.name(target);
  }

  private async approve(
    target: Tracked | null,
    ordered: ReadonlyArray<Tracked>,
    decision: "accept" | "decline",
  ): Promise<void> {
    const waiting = (target ? [target] : ordered).filter(
      (t) => t.thread.pendingRequest && t.thread.pendingRequest.kind in APPROVAL_WORDS,
    );
    const current = waiting.filter((t) => t.thread.threadId === this.current);
    if (waiting.length === 0) return this.say("现在没有在等批准的操作。");
    if (waiting.length > 1 && current.length === 0)
      return this.say("有好几个 session 在等批准，是哪个？");
    const to = (current[0] ?? waiting[0])!;
    await this.t3.respondToApproval(to.thread.threadId, to.thread.pendingRequest!.id, decision);
    this.lastTarget = this.name(to);
    this.say(
      decision === "accept"
        ? `批准了，${this.name(to)}接着做。`
        : `拒绝了，${this.name(to)}不会执行。`,
    );
  }

  private async quizAnswer(target: Tracked, answer: string): Promise<void> {
    const quiz = this.quiz.get(target.thread.threadId)!;
    quiz.answers.push(answer);
    this.lastTarget = this.name(target);
    const asked = quiz.answers.length;
    if (asked < quiz.questions.length)
      return this.news(`第 ${asked + 1} 个：${quiz.questions[asked]}`, { urgent: true });
    return this.sendQuiz(target, false);
  }

  private async sendQuiz(target: Tracked, partial: boolean): Promise<void> {
    const threadId = target.thread.threadId;
    const quiz = this.quiz.get(threadId)!;
    this.quiz.delete(threadId);
    const lines = quiz.answers.map((a, i) => `${i + 1}. ${quiz.questions[i]}\n   回答：${a}`);
    const message = `${partial ? "先回答这几个，剩下的以后再说：" : "按顺序回答你的问题："}\n${lines.join("\n")}`;
    await this.deliver(target, message);
    if (!this.current) this.setCurrent(threadId);
    this.confirm(target, `回答发给${this.name(target)}了。`);
  }

  private async launch(intent: Intent): Promise<void> {
    const task = (intent.message ?? "").trim();
    if (!task)
      return this.say("新 session 要做什么？连任务一起说，比如“新开一个，查一下 prod 的日志”。");
    const current = this.current ? this.tracked.get(this.current) : undefined;
    const projectId = this.projectNamed(intent.project) ?? current?.thread.projectId ?? null;
    if (!projectId) return this.say("开在哪个项目？带上项目名再说一次。");
    const before = new Set(this.tracked.keys());
    let note = "";
    let result: { readonly threadId: string | null };
    const mode = this.config().newSessionMode;
    try {
      result = await this.t3.launch(projectId, task + VOICE_NOTE, mode);
    } catch (error) {
      if (mode === "auto" || !(error instanceof T3Error) || !/mode/i.test(error.message))
        throw error;
      this.logger.warn(`voice: T3 refused a ${mode} session; using auto`, error);
      result = await this.t3.launch(projectId, task + VOICE_NOTE, "auto");
      note = "不过 T3 不让开完全放开的，用的是自动模式。";
    }
    await this.poll(); // track it right away
    let threadId = result.threadId;
    if (!threadId) {
      const fresh = [...this.tracked.values()].filter(
        (t) => !before.has(t.thread.threadId) && t.thread.projectId === projectId,
      );
      threadId = fresh.length === 1 ? fresh[0]!.thread.threadId : null;
    }
    if (threadId) {
      this.setCurrent(threadId);
      this.awaiting.add(threadId);
      this.lastSent = { threadId, message: task, at: this.now() };
    }
    const project = this.projects.get(projectId) ?? "项目";
    this.lastTarget =
      threadId && this.tracked.has(threadId) ? this.name(this.tracked.get(threadId)!) : project;
    this.say(`在${project}开好了，已经开始做了。${note}`);
  }

  private projectNamed(name: unknown): string | null {
    if (!name) return null;
    const wanted = String(name).toLowerCase().replaceAll(" ", "");
    for (const [id, title] of this.projects) {
      const flat = title.toLowerCase().replaceAll(" ", "");
      if (wanted === flat || flat.includes(wanted) || wanted.includes(flat)) return id;
    }
    return null;
  }

  /** "xx 怎么样了": its status plus what its last exchange says, not just "已完成". */
  private async report(target: Tracked): Promise<void> {
    const name = this.name(target);
    const status = STATUS_WORDS[target.thread.status] ?? target.thread.status;
    const followup = target.thread.threadId;
    const { asked, text } = await this.t3.lastExchange(target.thread.threadId);
    if (!text) return this.news(`${name}${status}，还没有回复。`, { urgent: true, followup });
    let summary = await this.llm.summarize(text, asked, { detailed: this.detailed });
    if (summary === "SKIP") summary = speakable(text, 80); // asked for it, so say it anyway
    const lead = ACTIVE_STATUSES.has(target.thread.status)
      ? `${name}${status}，上一轮说的是：`
      : `${name}${status}。`;
    this.news(lead + summary, { urgent: true, followup });
  }

  /** Take back the last message: stop the run it started and tell the agent to ignore it. */
  private async undo(): Promise<void> {
    const last = this.lastSent;
    if (!last || this.now() - last.at > Sessions.UNDO_WINDOW) return this.say("没有可以撤回的。");
    this.lastSent = null;
    await this.t3
      .interrupt(last.threadId)
      .catch((error) => this.logger.info(`voice undo: interrupt failed (${errorMessage(error)})`));
    await this.t3.send(
      last.threadId,
      `撤回：请忽略我上一条消息“${last.message}”，那是说错或识别错了，不要执行。如果已经改了什么，告诉我改了哪些。`,
      this.config().sendMode,
    );
    this.awaiting.add(last.threadId);
    this.say(`撤回了，已经让${this.nameOf(last.threadId)}停下并忽略那句。`);
  }
}

const wordLength = (text: string) => [...text.replace(NOT_WORD, "")].length;

function pick(ordered: ReadonlyArray<Tracked>, index: unknown): Tracked | null {
  const i =
    typeof index === "number"
      ? index
      : typeof index === "string" && /^\d+$/.test(index)
        ? Number(index)
        : NaN;
  return Number.isInteger(i) && i >= 1 && i <= ordered.length ? ordered[i - 1]! : null;
}

/**
 * Whether `text` names `name`, allowing one misheard character ("数据生成" for "数据生产":
 * recognition gets homophones wrong). Names under four characters must match exactly.
 */
export function mentions(text: string, name: string): boolean {
  const chars = [...name];
  if (chars.length < 2) return false;
  if (text.includes(name)) return true;
  if (chars.length < 4) return false;
  const pairs = chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
  return pairs.filter((p) => text.includes(p)).length >= pairs.length - 1;
}

/** Questions from T3 pending requests (JSON of unknown exact shape) as spoken lines. */
function spokenQuestions(requests: ReadonlyArray<unknown>): Array<string> {
  const lines: Array<string> = [];
  for (const request of requests) {
    if (!request || typeof request !== "object") continue;
    const nested = (request as { questions?: unknown }).questions;
    for (const q of Array.isArray(nested) && nested.length ? nested : [request]) {
      if (!q || typeof q !== "object") continue;
      const { question, header, prompt, options } = q as Record<string, unknown>;
      const text = [question, header, prompt].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (!text) continue;
      const labels = (Array.isArray(options) ? options : [])
        .map((o) => (o && typeof o === "object" ? (o as { label?: unknown }).label : undefined))
        .filter((l): l is string => typeof l === "string" && l.length > 0);
      lines.push(text + (labels.length ? ` 选项：${labels.join("、")}。` : ""));
    }
  }
  return lines;
}

/** Strip markdown that sounds bad read aloud. */
export function speakable(text: string, limit = 600): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, "（代码略）")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[#>|*-]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...plain].length <= limit
    ? plain
    : `${[...plain].slice(0, limit).join("")}……后面还有，去 T3 里看。`;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
