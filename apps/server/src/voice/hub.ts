// @effect-diagnostics globalTimers:off globalDate:off - plain-TS voice core, tested without an Effect runtime.
/**
 * The connected voice pages and apps and the spoken turns they start, transport-free.
 * The VoicePilot app speaks this protocol too: see docs/fwai/voice.md before changing it.
 */
import type { VoiceConfig } from "./config.ts";
import { type EndOfSpeech, isLive } from "./endOfSpeech.ts";
import type { Logger, Sessions } from "./sessions.ts";
import type { CueName, VoicePlayer } from "./speaker.ts";
import type { VoiceStore } from "./store.ts";

export interface VoiceSocket {
  send(message: Record<string, unknown> | Uint8Array): void;
}

export type Transcribe = (
  config: VoiceConfig,
  chunks: AsyncIterable<Uint8Array>,
  hotwords: ReadonlyArray<string>,
) => Promise<string>;

export interface HubDeps {
  readonly config: () => VoiceConfig;
  readonly sessions: Sessions;
  readonly speaker: { hold(): void; release(): void };
  readonly store: Pick<VoiceStore, "add" | "recent">;
  readonly transcribe: Transcribe;
  /** A fresh end-of-speech detector per turn; `startTimeout` is set for reply windows. */
  readonly endOfSpeech: (startTimeout: number | undefined) => Promise<EndOfSpeech>;
  readonly version: string;
  readonly logger?: Logger;
  /** Overridable in tests. */
  readonly deadMicSeconds?: number;
  readonly stalledSeconds?: number;
}

const FILLERS = new Set("嗯啊哦呃额哈唉诶欸呀噢喔");
const ONE_WORD_REPLIES = new Set("好行对是要不可发停"); // "要不要发版？" → "好"

/** Empty, a stray character, or only filler sounds ("嗯。", "啊啊"): what noise turns into. */
export function noWords(text: string): boolean {
  const chars = [...text.replace(/[\p{P}\p{S}\s]/gu, "")];
  if (chars.length === 1 && ONE_WORD_REPLIES.has(chars[0]!)) return false;
  return chars.length <= 1 || chars.every((c) => FILLERS.has(c));
}

/** Mic frames of one turn; `null` ends it. */
export class Mic {
  private readonly items: Array<Uint8Array | null> = [];
  private waiter: ((item: Uint8Array | null | undefined) => void) | null = null;

  put(item: Uint8Array | null): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(item);
    } else this.items.push(item);
  }

  /** The next frame, or `undefined` after `seconds` without one. */
  take(seconds: number): Promise<Uint8Array | null | undefined> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(undefined);
      }, seconds * 1000);
      this.waiter = (item) => {
        clearTimeout(timer);
        resolve(item);
      };
    });
  }
}

export interface VoiceConnection {
  receive(data: string | Uint8Array): void;
  close(): void;
}

/** A reply wait the client asked for, in seconds; anything else means the server's own. */
function replyWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, 1), 15)
    : undefined;
}

export class VoiceHub implements VoicePlayer {
  private readonly sockets = new Set<VoiceSocket>();
  private stopped = false;
  private busy = false;
  private cancelled = false;
  private listening: EndOfSpeech | null = null;
  private frames = 0;
  private lastState = "";
  private readonly logger: Logger;

  private readonly deps: HubDeps;

  constructor(deps: HubDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? { info: () => {}, warn: () => {} };
  }

  get size(): number {
    return this.sockets.size;
  }

  broadcast(message: Record<string, unknown>): void {
    for (const socket of this.sockets) socket.send(message);
  }

  /** An announcement is starting: keep it and show it everywhere. */
  announce(text: string, followup: string | null): void {
    this.deps.store.add("said", text);
    this.broadcast({ type: "say", text, followup });
  }

  /** Push the session list and modes when they changed. */
  publishState(): void {
    const { sessions } = this.deps;
    const state = JSON.stringify([
      sessions.snapshot(),
      sessions.passive,
      sessions.detailed,
      sessions.describeCurrent(),
    ]);
    if (state === this.lastState || this.sockets.size === 0) return;
    this.lastState = state;
    for (const socket of this.sockets) this.sendState(socket);
  }

  private sendState(socket: VoiceSocket): void {
    const { sessions } = this.deps;
    socket.send({ type: "sessions", items: sessions.snapshot() });
    socket.send({ type: "current", text: sessions.describeCurrent() });
    socket.send({ type: "passive", on: sessions.passive });
    socket.send({ type: "detail", on: sessions.detailed });
  }

  cue(name: CueName): void {
    this.broadcast({ type: name }); // clients own the tones
  }

  stop(): void {
    this.stopped = true;
    this.broadcast({ type: "audio_stop" });
  }

  async play(chunks: AsyncIterable<Uint8Array>, sampleRate: number): Promise<void> {
    this.stopped = false;
    if (this.sockets.size === 0) return; // nobody listening: don't even synthesize
    this.broadcast({ type: "audio_start", rate: sampleRate });
    for await (const chunk of chunks) {
      if (this.stopped) return;
      for (const socket of this.sockets) socket.send(chunk);
    }
    this.broadcast({ type: "audio_end" });
  }

  connect(socket: VoiceSocket): VoiceConnection {
    this.sockets.add(socket);
    socket.send({ type: "hello", version: this.deps.version });
    this.sendState(socket);
    socket.send({ type: "history", items: this.deps.store.recent() });
    let mic: Mic | null = null;
    const endMic = () => {
      mic?.put(null);
      mic = null;
    };
    return {
      receive: (data) => {
        if (typeof data !== "string") {
          mic?.put(data);
          return;
        }
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        const { sessions } = this.deps;
        switch (message.type) {
          case "start": {
            if (this.busy) {
              socket.send({ type: "mic_stop" });
              socket.send({ type: "error", text: "另一个页面正在说话，等一下。" });
              return;
            }
            mic = new Mic();
            const followup = message.followup ? String(message.followup) : null;
            void this.runTurn(socket, mic, followup, replyWindow(message.followupSeconds)).catch(
              (error) => this.logger.warn("voice turn failed", error),
            );
            return;
          }
          case "ready":
            return this.listening?.restartStartTimeout(); // the beep has been heard
          case "stop":
            return endMic();
          case "inbox":
            if (mic) {
              this.cancelled = true; // double press: the user wants the inbox, not a turn
              endMic();
            }
            return sessions.readInbox();
          case "replay":
            return sessions.replay();
          case "select":
            if (!sessions.select(String(message.id)))
              socket.send({ type: "error", text: "这个 session 已经不在了。" });
            return this.publishState();
          case "passive":
            sessions.setPassive(Boolean(message.on));
            return this.publishState();
          case "detail":
            sessions.setDetailed(Boolean(message.on));
            return this.publishState();
          case "debug":
            return this.logger.info(`voice page: ${String(message.text).slice(0, 300)}`);
        }
      },
      close: () => {
        this.sockets.delete(socket);
        endMic();
      },
    };
  }

  /** One turn. `followup`: opened right after news from that session; silence is fine then. */
  async runTurn(
    socket: VoiceSocket,
    mic: Mic,
    followup: string | null,
    followupSeconds?: number,
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.deps.speaker.hold();
    this.frames = 0;
    this.cancelled = false;
    let heard: { text: string; detector: EndOfSpeech; dead: boolean };
    try {
      heard = await this.listen(
        socket,
        mic,
        followup ? (followupSeconds ?? this.deps.config().followupSeconds) : undefined,
      );
    } catch (error) {
      if (this.cancelled) return;
      this.logger.warn(`voice recognition failed after ${this.frames} audio frames`, error);
      socket.send({ type: "mic_stop" });
      socket.send({
        type: "error",
        text:
          this.frames === 0
            ? "服务器没收到声音：录音没开起来。"
            : `语音识别出错了：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    } finally {
      this.deps.speaker.release();
      this.busy = false;
    }
    if (this.cancelled) return;
    const { text, detector, dead } = heard;
    if (dead)
      return socket.send({ type: "error", text: "麦克风没有声音。看一下有没有允许用麦克风。" });
    if (!detector.heardSpeech) {
      // A reply window that closed in silence has nothing to say.
      return socket.send(followup ? { type: "nothing" } : { type: "error", text: "没听到说话。" });
    }
    if (followup && noWords(text)) {
      this.logger.info(`voice: only noise in the reply window (${JSON.stringify(text)})`);
      return socket.send({ type: "nothing" });
    }
    socket.send({ type: "heard", text });
    const { sessions } = this.deps;
    await sessions.handle(text, followup);
    const target = sessions.lastTarget;
    this.deps.store.add("heard", text, target);
    if (target) socket.send({ type: "tag", session: target });
    this.publishState();
  }

  private async listen(socket: VoiceSocket, mic: Mic, startTimeout: number | undefined) {
    const detector = await this.deps.endOfSpeech(startTimeout);
    this.listening = detector;
    const toAsr = new Mic();
    const started = Date.now();
    let dead = false;
    // Separate from the recognition stream so the beep doesn't wait for its connection.
    const watch = async () => {
      let live = false;
      try {
        for (;;) {
          const chunk = await mic.take(this.deps.stalledSeconds ?? 5); // the client went away
          if (!chunk) break;
          this.frames++;
          toAsr.put(chunk);
          if (!live && isLive(chunk)) {
            live = true;
            socket.send({ type: "live" });
          } else if (!live && Date.now() - started > (this.deps.deadMicSeconds ?? 4) * 1000) {
            dead = true;
            break;
          }
          if (live && (await detector.feed(chunk))) break;
        }
      } finally {
        toAsr.put(null);
        socket.send({ type: "mic_stop" });
      }
    };
    async function* chunks() {
      for (;;) {
        const chunk = await toAsr.take(3600);
        if (!chunk) return;
        yield chunk;
      }
    }
    const watching = watch();
    try {
      const text = await this.deps.transcribe(
        this.deps.config(),
        chunks(),
        this.deps.sessions.hotwords(),
      );
      return { text, detector, dead };
    } finally {
      this.listening = null;
      mic.put(null);
      await watching;
    }
  }
}
