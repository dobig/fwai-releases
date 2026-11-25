import { describe, expect, it, vi } from "vite-plus/test";

import { ASR_SAMPLE_RATE, DEFAULT_VOICE_CONFIG } from "./config.ts";
import { EndOfSpeech } from "./endOfSpeech.ts";
import type { Transcribe } from "./asr.ts";
import { Mic, noWords, VoiceHub, type HistoryEvent, type VoiceSocket } from "./hub.ts";
import type { Intent, VoiceLlm } from "./llm.ts";
import { Sessions, type VoiceT3 } from "./sessions.ts";

class Client implements VoiceSocket {
  messages: Array<Record<string, unknown>> = [];
  audio = 0;
  send(message: Record<string, unknown> | Uint8Array) {
    if (message instanceof Uint8Array) this.audio++;
    else this.messages.push(message);
  }
  types() {
    return this.messages.map((m) => m.type);
  }
}

function chunk(amplitude: number, seconds = 0.2): Uint8Array {
  const samples = new Int16Array(Math.round(ASR_SAMPLE_RATE * seconds));
  for (let i = 0; i < samples.length; i++)
    samples[i] = Math.trunc(amplitude * Math.sin((i * 2 * Math.PI * 220) / ASR_SAMPLE_RATE));
  return new Uint8Array(samples.buffer);
}

const t3: VoiceT3 = {
  projects: async () => [],
  threads: async () => [],
  send: async () => {},
  interrupt: async () => {},
  lastExchange: async () => ({ asked: null, text: null }),
  pendingQuestions: async () => [],
  respondToApproval: async () => {},
  launch: async () => ({ threadId: null }),
};

function setup(heard: string) {
  const handled: Array<[string, string | null]> = [];
  const llm: VoiceLlm = {
    parseIntent: async (): Promise<Intent> => ({ action: "none", reply: "嗯？" }),
    summarize: async (text) => text,
    readQuestion: async (text) => text,
    extractQuestions: async () => [],
    mergeNotices: async (_name, parts) => parts.join(" "),
  };
  const speaker = {
    last: null,
    say: () => {},
    cue: () => {},
    held: 0,
    hold() {
      this.held++;
    },
    release() {},
    silenced: 0,
    silence() {
      this.silenced++;
    },
  };
  const sessions = new Sessions({ config: () => DEFAULT_VOICE_CONFIG, t3, llm, speaker });
  sessions.initialized = true;
  const original = sessions.handle.bind(sessions);
  sessions.handle = async (text, followup = null) => {
    handled.push([text, followup]);
    return original(text, followup);
  };
  const history: Array<HistoryEvent> = [];
  const transcribe: Transcribe = async (_config, chunks, _hotwords, onPartial) => {
    for await (const _ of chunks) {
      // drain what the page sends, as the recognizer does
    }
    if (heard) onPartial?.(heard.slice(0, 2));
    return heard;
  };
  const windows: Array<number | undefined> = [];
  const detectors: Array<EndOfSpeech> = [];
  const hub = new VoiceHub({
    config: () => DEFAULT_VOICE_CONFIG,
    sessions,
    speaker,
    store: {
      add: (kind, text, session = null) => {
        const event = { at: 0, kind, text, session };
        history.push(event);
        return event;
      },
      recent: () => history,
    },
    transcribe,
    endOfSpeech: async (startTimeout) => {
      windows.push(startTimeout);
      const detector = new EndOfSpeech(null, 0.4, startTimeout ?? 6);
      detectors.push(detector);
      return detector;
    },
    version: "test",
    stalledSeconds: 0.05,
  });
  return { hub, handled, history, speaker, windows, detectors };
}

describe("noWords", () => {
  it("counts noise in the reply window as nothing", () => {
    for (const noise of ["", "。", "嗯", "嗯。", "啊啊", "呃，嗯"])
      expect(noWords(noise), noise).toBe(true);
    for (const words of ["好", "不", "好的", "上 prod 吧", "嗯，先别发"])
      expect(noWords(words), words).toBe(false);
  });
});

describe("Mic", () => {
  it("hands frames over in order and ends on null", async () => {
    const mic = new Mic();
    mic.put(Uint8Array.of(1));
    const waiting = mic.take(1);
    expect(await waiting).toEqual(Uint8Array.of(1));
    const next = mic.take(1);
    mic.put(null);
    expect(await next).toBeNull();
  });
});

describe("VoiceHub", () => {
  it("greets a client with the state and history", () => {
    const { hub } = setup("");
    const client = new Client();
    hub.connect(client);
    expect(client.types()).toEqual([
      "hello",
      "sessions",
      "current",
      "passive",
      "detail",
      "history",
    ]);
  });

  it("runs a turn: live, heard, handled, kept in history", async () => {
    const { hub, handled, history, speaker } = setup("现在是哪个");
    const client = new Client();
    const mic = new Mic();
    for (const amplitude of [50, 50, 3000, 3000, 60, 60, 60]) mic.put(chunk(amplitude));
    await hub.runTurn(client, mic, null);
    expect(client.types()).toContain("live");
    expect(client.messages.find((m) => m.type === "heard")).toEqual({
      type: "heard",
      text: "现在是哪个",
    });
    expect(handled).toEqual([["现在是哪个", null]]);
    expect(history.map((e) => [e.kind, e.text])).toEqual([["heard", "现在是哪个"]]);
    expect(speaker.held).toBe(1);
    expect(client.messages.find((m) => m.type === "partial")).toEqual({
      type: "partial",
      text: "现在",
    });
  });

  it("stops all speech on silence", () => {
    const { hub, speaker } = setup("");
    const connection = hub.connect(new Client());
    connection.receive(JSON.stringify({ type: "silence" }));
    expect(speaker.silenced).toBe(1);
  });

  it("ends a silent reply window quietly", async () => {
    const { hub, handled } = setup("");
    const client = new Client();
    const mic = new Mic();
    for (let i = 0; i < 10; i++) mic.put(chunk(50));
    await hub.runTurn(client, mic, "t1");
    expect(client.types()).toEqual(["live", "mic_stop", "nothing"]);
    expect(handled).toEqual([]);
  });

  it("drops noise heard in a reply window", async () => {
    const { hub, handled } = setup("嗯。");
    const client = new Client();
    const mic = new Mic();
    for (const amplitude of [50, 50, 3000, 3000, 60, 60, 60]) mic.put(chunk(amplitude));
    await hub.runTurn(client, mic, "t1");
    expect(client.types().at(-1)).toBe("nothing");
    expect(handled).toEqual([]);
  });

  it("refuses a second turn while one runs", () => {
    const { hub } = setup("");
    const first = hub.connect(new Client());
    const other = new Client();
    const second = hub.connect(other);
    first.receive(JSON.stringify({ type: "start" }));
    other.messages = [];
    second.receive(JSON.stringify({ type: "start" }));
    expect(other.messages).toEqual([
      { type: "mic_stop" },
      { type: "error", text: "另一个页面正在说话，等一下。" },
    ]);
    first.close();
  });

  it("streams speech to every client and stops when cut off", async () => {
    const { hub } = setup("");
    const a = new Client();
    const b = new Client();
    hub.connect(a);
    hub.connect(b);
    async function* speech() {
      yield new Uint8Array(4);
      hub.stop();
      yield new Uint8Array(4);
    }
    await hub.play(speech(), 24_000);
    expect([a.audio, b.audio]).toEqual([1, 1]);
    expect(a.types().slice(-2)).toEqual(["audio_start", "audio_stop"]);
  });

  it("waits as long as the app asked for a reply, within bounds", async () => {
    const { hub, windows } = setup("");
    const wait = async (followupSeconds?: unknown) => {
      const before = windows.length;
      const client = new Client();
      const connection = hub.connect(client);
      connection.receive(
        JSON.stringify({
          type: "start",
          followup: "t1",
          ...(followupSeconds === undefined ? {} : { followupSeconds }),
        }),
      );
      await vi.waitFor(() => expect(windows.length).toBe(before + 1));
      connection.receive(JSON.stringify({ type: "stop" }));
      await vi.waitFor(() => expect(client.types()).toContain("nothing")); // the turn is over
    };
    await wait(4);
    await wait(99);
    await wait(0);
    await wait("soon");
    await wait();
    expect(windows).toEqual([
      4,
      15,
      1,
      DEFAULT_VOICE_CONFIG.followupSeconds,
      DEFAULT_VOICE_CONFIG.followupSeconds,
    ]);
  });

  it("starts counting the reply wait when the app says the beep was heard", async () => {
    const { hub, detectors } = setup("");
    const client = new Client();
    const connection = hub.connect(client);
    connection.receive(JSON.stringify({ type: "start", followup: "t1", followupSeconds: 1 }));
    await vi.waitFor(() => expect(detectors.length).toBe(1));
    const [detector] = detectors;
    for (let i = 0; i < 4; i++) expect(await detector!.feed(chunk(50))).toBeNull(); // 0.8 s
    connection.receive(JSON.stringify({ type: "ready" }));
    for (let i = 0; i < 4; i++) expect(await detector!.feed(chunk(50))).toBeNull(); // 0.8 s again
    expect(await detector!.feed(chunk(50))).toBe("timeout");
    connection.receive(JSON.stringify({ type: "stop" }));
    await vi.waitFor(() => expect(client.types()).toContain("nothing"));
  });
});
