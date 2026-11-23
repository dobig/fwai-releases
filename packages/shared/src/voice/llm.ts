// @effect-diagnostics globalFetch:off - plain-TS voice core, tested without an Effect runtime.
/**
 * Doubao LLM on Volcengine Ark (OpenAI-compatible chat completions). Two jobs: turn a
 * spoken utterance into a command, and turn a long agent reply into one or two
 * sentences that sound fine in an earpiece. Prompts are Chinese: so is the user.
 */
import { doubaoAccess, timeoutSignal, type VoiceConfig } from "./config.ts";

const INTENT_PROMPT =
  '你是一个语音遥控器，帮用户用语音操作多个 AI 编程 session。\n根据用户说的话和当前 session 列表，输出一个 JSON 对象（只输出 JSON，不要解释）：\n\n{"action": "...", "session": <编号或 null>, "message": <字符串或 null>, "reply": <字符串或 null>}\n\naction 取值：\n- "send"：把用户的话发给某个 session，让那个 AI 去做或去回答。message 是要发给它的原文（去掉“告诉 xxx”“给 xxx 说”这类称呼部分，保留用户的原意和措辞，可以修正明显的语音识别错字）。\n- "answer"：回答某个 session 刚提出的问题（列表里状态是“在等你回答”的那个）。message 是回答的原文（比如“选第二个”“就用默认值”“可以，删掉”）。\n- "select"：把某个 session 设为当前 session，不下指令（“切到 zr33”“换成网关”“以后跟 2 号说”）。\n- "passive"：切换被动模式。打开（“打开被动模式”“别主动播了”“安静点，我问了再说”）message 填 "on"；关闭（“切回主动模式”“有进度直接播”）message 填 "off"。session 填 null。\n- "detail"：切换播报的详细程度。要详细（“详细模式”“说详细点”“念全一点，别删”）message 填 "on"；要简洁（“简洁模式”“说简短点”“只说重点”）message 填 "off"。session 填 null。\n- "current"：问现在的当前 session 是哪个（“现在是哪个”“当前 session 是谁”）。\n- "status"：问 session 的运行状态（“在干嘛”“怎么样了”“跑完没”“进度如何”；session 为 null 表示全部）。\n- "read"：要听 session 上一条回复的概括。只有用户明确提到“它说了/回复了/讲了什么”“再念一下它的回复”这类话时才用。\n- "read_full"：要听上一条回复的原文（“念一下完整的”“全文念一遍”）。\n- "stop"：中断某个 session 正在跑的任务。\n- "approve"：批准或拒绝某个 session 在等的权限请求（执行命令、改文件等）。批准（“批准”“同意”“可以，执行吧”“允许”）message 填 "accept"；拒绝（“拒绝”“不行”“别执行”）message 填 "decline"。没说是哪个 session 时填 null。\n- "list"：列出有哪些 session。\n- "new"：新开一个 session（“新开一个 session，……”“在 llm_gateway 里开个新的，……”“新建一个会话去查日志”）。message 是交给新 session 的任务（去掉“新开一个”这类说法）；用户说了项目就在 JSON 里加 "project": 项目列表里对应的名字，没说就填 null。session 填 null。\n- "undo"：撤回刚才发出去的那句话（“撤回”“撤销”“刚才那句不对”“刚才说错了”“取消刚才发的”）。session 填 null。\n- "alias"：给某个 session 起个名字（“把迁移部署那个叫部署”“给 2 号起个名叫网关”）。session 是被起名的那个，message 是新名字。\n- "repeat"：重播刚才播过的最后一条语音（“重播”“再说一遍”“刚才那条再播一下”“没听清”“刚才说的啥”）。\n- "inbox"：听其他 session 攒下的新通知（“听通知”“有什么通知”“念一下新消息”“网关的通知”）。点名了某个 session 就填它，否则 session 填 null。\n- "none"：明显不是在对你说话（自言自语、和旁人聊天）。reply 写一句简短的中文反问。\n\n怎么判断（最重要）：\n- 用户用“对 xx 说”“给 xx 说/发”“跟 xx 讲”“告诉 xx”点名开口时，一律是 "send"，message 是后面的话，哪怕那句话本身像是在问进度（“对数据生产说，情况怎么样？”→ send，message “情况怎么样？”）。只有不带这类说法的“xx 怎么样了”才是 status。\n- 默认是 "send"。用户问的任何具体问题（为什么、会不会、能不能、怎么、有什么问题、你觉得、测试过了吗……）、提的任何要求、发表的看法，都是要发给 session 的 AI 去回答或去做，用 "send"。\n- read / read_full / status / repeat / current / list / inbox / passive / detail / undo / alias / new / approve 只用于“关于 session 本身”的元操作，并且用户的话里要有对应的明确说法；拿不准时一律用 "send"，不要用 read，也不要用 none。\n- 例子：“按通话音质会有什么问题？”→ send；“为什么要等一秒多？”→ send；“测试都过了吗？”→ send；“你觉得用哪个方案好？”→ send；“它刚才说了啥”→ read；“网关怎么样了”→ status。\n\n选哪个 session：\n- session 用列表里的编号。用户可能用别名、标题里的关键词、项目名、谐音来指代 session，尽量匹配。\n- 用户没点名 session 时，send / read / read_full / stop 一律用“当前 session”，不要根据内容去猜别的 session。只有用户明确叫出另一个 session 的名字、别名或编号时才用别的。\n- 有 session 在等你回答、而用户的话像是在回答问题（选择、确认、提供信息）时，用 "answer"；没说是哪个 session 时，发给在等的那个。\n- 没有当前 session、用户也没点名时，session 填 null。\n';
const SUMMARY_PROMPT =
  "用户戴着耳机、看不到屏幕，你要把一个 AI 编程助手的回复改写成一段播报给他听。\n\n- 严格控制长度：一到两句话，不超过 60 个字。宁可少说，也不要超。\n- 给了“用户的问题”时，第一句直接回答这个问题，不要绕。\n- 只挑最关键的一两个具体信息（名字、数字、结论），比如“admin-web 和 enterprise-web 两个容器”；次要细节（端口、原因、背景、建议）全部省掉。不要说“已完成配置”“已处理好”这种不带信息的空话。\n- 不要念代码块、文件路径、命令、链接、表格。英文名字和技术词照原样保留。\n- 只有回复里明确要用户做决定或回答问题时，最后一句才说要用户定什么、有哪些选项；否则什么都不用说，绝对不要说“无需你操作”“无需你决定”这类话。\n- 回复里有好几个要用户回答的问题时，只说第一个（连同它的选项），后面加一句“还有 N 个问题。”（N 是剩下的数量）。用户在听，一次记不住好几个问题。\n- 不要开场白，不要复述用户的问题，不要说“助手说”。\n- 如果这条回复没有任何新进展、新结果，也不需要用户做什么（比如只是说“这次唤醒没有其他动作”“继续等后台任务”“还在跑，没有变化”），只输出四个字母 SKIP，别的都不要写。";
const EXTRACT_PROMPT =
  '下面是一个 AI 编程助手的回复。把其中需要用户回答或决定的问题按顺序找出来，每个问题改写成一句适合耳机里念的口语中文，有选项就带上选项（“……，选 A 还是 B？”），每句不超过 40 个字。\n只输出 JSON 字符串数组，比如 ["日志级别用 info 还是 debug？", "要不要把 #575 一起上 prod？"]。没有问题就输出 []。';
const MERGE_PROMPT =
  "同一个 AI 编程 session 先后发来了几条进度通知，用户还没听。把它们合成一条耳机播报，用户只听这一条。\n- 以“{session 名}”开头，比如“数据生产：……”。\n- 标着“最新”的那条就是现在的状态，先说它，而且必须照它说：它说没做完就是没做完，它说还没产出就是还没产出。较早的通知只能补充最新一条没提到、而且没被推翻的事，不能用较早的内容改写最新状态。\n- 保留关键的名字、数字、结论；如果有任何一条需要用户决定、回答或批准，一定要说出来。\n- 口语中文，一到两句话，不超过 60 个字。不要开场白，不要念代码、路径、链接。";
const DETAIL_PROMPT =
  "用户戴着耳机、看不到屏幕，要听一个 AI 编程助手回复的完整内容（详细模式）。把回复改写成能直接念的口语中文：\n- 不要删减内容，不要概括，信息、结论、数字、名字、理由都保留，顺序也照原文。\n- 只改听不了的形式：代码块说清楚它是做什么的（不念代码）；文件路径只说文件名；链接不念；表格逐行念成句子；列表念成“第一……第二……”。英文名字和技术词照原样保留。\n- 回复里有好几个要用户回答的问题时，正文照常念完，问题只念第一个（连同选项），后面加一句“还有 N 个问题。”（N 是剩下的数量）。\n- 不要开场白，不要说“助手说”。超过 800 字就念到 800 字左右，最后说“后面还有，去 T3 里看”。";
const QUESTION_PROMPT =
  "一个 AI 编程助手停下来在等用户回答，下面是它提的问题（JSON，来自 T3）。用户戴着耳机、看不到屏幕。\n把问题用口语中文念出来，但一次只念一个：只念第一个问题；有选项就把选项按顺序说出来（“第一，……；第二，……”），选项名照原样念。如果还有别的问题，最后加一句“还有 N 个问题，答完这个再说”。\n只念 JSON 里有的内容，不要自己补充或编造问题。不超过 80 个字，选项的说明能省就省，只念选项名。不要念 id、代码、路径、链接。不要开场白。";

class LlmError extends Error {}

export interface SessionListing {
  readonly index: number;
  readonly name: string;
  readonly project: string;
  readonly status: string;
  readonly aliases: ReadonlyArray<string>;
}

export interface Intent {
  readonly action?: string;
  readonly session?: number | string | null;
  readonly message?: string | null;
  readonly reply?: string | null;
  readonly project?: string | null;
}

/** What the voice core needs from a language model; tests pass a fake. */
export interface VoiceLlm {
  parseIntent(
    utterance: string,
    sessions: ReadonlyArray<SessionListing>,
    current: number | null,
    projects?: ReadonlyArray<string>,
  ): Promise<Intent>;
  summarize(
    text: string,
    question?: string | null,
    options?: { readonly detailed?: boolean },
  ): Promise<string>;
  readQuestion(request: string): Promise<string>;
  extractQuestions(text: string): Promise<Array<string>>;
  mergeNotices(name: string, parts: ReadonlyArray<string>): Promise<string>;
}

export class DoubaoLlm implements VoiceLlm {
  private readonly config: () => VoiceConfig;

  constructor(config: () => VoiceConfig) {
    this.config = config;
  }

  private async chat(system: string, user: string, maxTokens: number): Promise<string> {
    const config = this.config();
    const access = doubaoAccess(config);
    if (!access || !config.llmModel) throw new LlmError("缺少豆包大模型配置");
    // Through the relay, the key and the model are the relay's.
    const url =
      access.kind === "direct"
        ? `${config.llmBaseUrl.replace(/\/+$/, "")}/chat/completions`
        : `${access.base}/chat/completions`;
    const auth =
      access.kind === "direct"
        ? { Authorization: `Bearer ${access.apiKey}` }
        : await access.authorize("POST", url);
    const response = await fetch(url, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.llmModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        ...(config.llmDisableThinking ? { thinking: { type: "disabled" } } : {}),
      }),
      signal: timeoutSignal(30_000),
    });
    if (!response.ok)
      throw new LlmError(
        `豆包大模型 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    return body.choices?.[0]?.message?.content ?? "";
  }

  async parseIntent(
    utterance: string,
    sessions: ReadonlyArray<SessionListing>,
    current: number | null,
    projects: ReadonlyArray<string> = [],
  ): Promise<Intent> {
    const listing = sessions
      .map(
        (s) =>
          `[${s.index}] ${s.name}（项目 ${s.project}，状态 ${s.status}${s.aliases.length ? `，别名 ${s.aliases.join("/")}` : ""}）`,
      )
      .join("\n");
    const user =
      `session 列表：\n${listing || "（没有 session）"}\n\n` +
      `项目列表：${projects.join("、") || "（未知）"}\n\n` +
      `当前 session：${current ?? "无"}\n\n` +
      `用户说：${utterance}`;
    return extractJson(await this.chat(INTENT_PROMPT, user, 600));
  }

  async extractQuestions(text: string): Promise<Array<string>> {
    const raw = await this.chat(EXTRACT_PROMPT, text.slice(-8000), 600);
    const match = /\[[\s\S]*\]/.exec(raw);
    try {
      const items: unknown = match ? JSON.parse(match[0]) : [];
      return Array.isArray(items) ? items.map((q) => String(q).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async mergeNotices(name: string, parts: ReadonlyArray<string>): Promise<string> {
    const listing = parts
      .map((p, i) => `${i === parts.length - 1 ? "【最新】" : `【较早 ${i + 1}】`}${p}`)
      .join("\n");
    return (
      await this.chat(
        MERGE_PROMPT,
        `session：${name}\n\n按时间先后的几条通知（最后一条是最新的）：\n${listing}`,
        300,
      )
    ).trim();
  }

  async summarize(
    text: string,
    question?: string | null,
    options?: { readonly detailed?: boolean },
  ): Promise<string> {
    if (options?.detailed)
      return (await this.chat(DETAIL_PROMPT, withQuestion(text, question), 1500)).trim();
    return (await this.chat(SUMMARY_PROMPT, withQuestion(text, question), 300)).trim();
  }

  async readQuestion(request: string): Promise<string> {
    return (await this.chat(QUESTION_PROMPT, request.slice(0, 6000), 300)).trim();
  }
}

function withQuestion(text: string, question?: string | null): string {
  const clipped = text.length <= 12_000 ? text : `${text.slice(0, 4000)}\n……\n${text.slice(-8000)}`;
  if (!question) return `助手的回复：\n${clipped}`;
  return `用户的问题：\n${question.slice(0, 2000)}\n\n助手的回复：\n${clipped}`;
}

const UNPARSED: Intent = { action: "none", reply: "没听懂，再说一遍？" };

export function extractJson(raw: string): Intent {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return UNPARSED;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return parsed && typeof parsed === "object" ? (parsed as Intent) : UNPARSED;
  } catch {
    return UNPARSED;
  }
}
