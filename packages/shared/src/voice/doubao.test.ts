import { describe, expect, it } from "vite-plus/test";

import {
  type AsrSocketHandlers,
  AUDIO_ONLY_REQUEST,
  decodeFrame,
  encodeFrame,
  FLAG_LAST,
  FLAG_LAST_WITH_SEQUENCE,
  FLAG_SEQUENCE,
  FULL_SERVER_RESPONSE,
  isLast,
  makeTranscribe,
} from "./asr.ts";
import { DEFAULT_VOICE_CONFIG, doubaoAccess, type VoiceConfig, type VoiceRelay } from "./config.ts";
import { DoubaoLlm, extractJson } from "./llm.ts";
import { decodeBase64, JsonObjectSplitter, makeSynthesize, type StreamingFetch } from "./tts.ts";

const utf8 = new TextEncoder();

function serverFrame(payload: unknown, last: boolean): Uint8Array {
  const body = utf8.encode(JSON.stringify(payload));
  const frame = new Uint8Array(12 + body.length);
  frame.set([
    0x11,
    (FULL_SERVER_RESPONSE << 4) | (last ? FLAG_LAST_WITH_SEQUENCE : FLAG_SEQUENCE),
    0x10,
    0,
  ]);
  const view = new DataView(frame.buffer);
  view.setInt32(4, last ? -3 : 2);
  view.setUint32(8, body.length);
  frame.set(body, 12);
  return frame;
}

/** The mobile app's view of the relay: a DPoP token and a proof per call. */
const dpopRelay = (calls: Array<[string, string]>): VoiceRelay => ({
  base: "https://relay.test/v1/voice",
  authorize: async (method, url) => {
    calls.push([method, url]);
    return { Authorization: "DPoP token", DPoP: `proof:${method}:${url}` };
  },
});

describe("Doubao speech recognition frames", () => {
  it("lays out an uncompressed client frame", () => {
    const frame = encodeFrame(AUDIO_ONLY_REQUEST, FLAG_LAST, Uint8Array.from([1, 2]), {
      json: false,
    });
    expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x22, 0x00, 0x00]);
    expect(new DataView(frame.buffer).getUint32(4)).toBe(2);
    expect([...frame.subarray(8)]).toEqual([1, 2]);
  });

  it("decodes a server response and an error", () => {
    const decoded = decodeFrame(serverFrame({ result: { text: "你好" } }, true));
    expect(decoded.payload).toEqual({ result: { text: "你好" } });
    expect(decoded.sequence).toBe(-3);
    expect(isLast(decoded)).toBe(true);

    const message = utf8.encode("bad audio");
    const error = new Uint8Array(12 + message.length);
    error.set([0x11, 0xf0, 0x10, 0]);
    new DataView(error.buffer).setUint32(4, 45000151);
    new DataView(error.buffer).setUint32(8, message.length);
    error.set(message, 12);
    expect(decodeFrame(error).error).toEqual({ code: 45000151, message: "bad audio" });
  });
});

describe("Doubao speech synthesis", () => {
  it("decodes base64 without Buffer", () => {
    expect([...decodeBase64("AQID")]).toEqual([1, 2, 3]);
    expect([...decodeBase64("AAEC/w==")]).toEqual([0, 1, 2, 255]);
  });

  it("splits concatenated JSON objects however the stream is cut", () => {
    const splitter = new JsonObjectSplitter();
    expect(splitter.push('{"code":0,"data":"a}{"}{"co')).toEqual([{ code: 0, data: "a}{" }]);
    expect(splitter.push('de":20000000}')).toEqual([{ code: 20000000 }]);
  });
});

describe("intent JSON", () => {
  it("tolerates wrapping and falls back to asking again", () => {
    expect(extractJson('```json\n{"action": "send", "session": 2}\n```').session).toBe(2);
    expect(extractJson("嗯？").action).toBe("none");
  });
});

describe("Doubao through the relay", () => {
  it("prefers a local key, else the relay, else nothing", () => {
    const relay = dpopRelay([]);
    expect(doubaoAccess({ ...DEFAULT_VOICE_CONFIG, doubaoApiKey: "k", relay })).toEqual({
      kind: "direct",
      apiKey: "k",
    });
    expect(doubaoAccess({ ...DEFAULT_VOICE_CONFIG, relay })).toMatchObject({
      kind: "relay",
      base: "https://relay.test/v1/voice",
    });
    expect(doubaoAccess(DEFAULT_VOICE_CONFIG)).toBeNull();
  });

  it("signs every call for its own method and URL, and never sends a key", async () => {
    const signed: Array<[string, string]> = [];
    const config: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, relay: dpopRelay(signed) };
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];

    const fetchTts: StreamingFetch = async (url, init) => {
      requests.push({ url, headers: init.headers });
      const body = utf8.encode('{"code":0,"data":"AQID"}{"code":20000000}');
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body.subarray(0, 7));
            controller.enqueue(body.subarray(7));
            controller.close();
          },
        }),
        text: async () => "",
      };
    };
    const audio: Array<number> = [];
    for await (const chunk of makeSynthesize(fetchTts, () => "id")(config, "你好"))
      audio.push(...chunk);
    expect(audio).toEqual([1, 2, 3]);

    let opened: { url: string; headers: Record<string, string> } | null = null;
    const transcribe = makeTranscribe({
      randomId: () => "id",
      open: async (url, headers, handlers: AsrSocketHandlers) => {
        opened = { url, headers };
        return {
          send: (frame) => {
            if (isLast(decodeFrame(frame)))
              handlers.message(serverFrame({ result: { text: "你好" } }, true));
          },
          close: () => {},
        };
      },
    });
    async function* mic() {
      yield new Uint8Array(320);
      yield new Uint8Array(320);
    }
    expect(await transcribe(config, mic())).toBe("你好");

    expect(requests[0]?.url).toBe("https://relay.test/v1/voice/tts");
    expect(requests[0]?.headers.DPoP).toBe("proof:POST:https://relay.test/v1/voice/tts");
    expect(opened).toEqual({
      url: "wss://relay.test/v1/voice/asr",
      headers: { Authorization: "DPoP token", DPoP: "proof:GET:https://relay.test/v1/voice/asr" },
    });
    expect(signed).toEqual([
      ["POST", "https://relay.test/v1/voice/tts"],
      ["GET", "https://relay.test/v1/voice/asr"],
    ]);
    for (const request of requests) expect(request.headers["X-Api-Key"]).toBeUndefined();
  });

  it("fails, rather than hearing nothing, when the connection closes before the last packet", async () => {
    const transcribe = makeTranscribe({
      randomId: () => "id",
      open: async (_url, _headers, handlers) => ({
        send: () => handlers.close(1011, "upstream gone"),
        close: () => {},
      }),
    });
    async function* mic() {
      yield new Uint8Array(320);
    }
    await expect(
      transcribe({ ...DEFAULT_VOICE_CONFIG, relay: dpopRelay([]) }, mic()),
    ).rejects.toThrow(/提前关闭/);
  });

  it("sends the LLM through the relay with the signed headers", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ choices: [{ message: { content: "好的" } }] }));
    }) as typeof fetch;
    try {
      const config: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, relay: dpopRelay([]) };
      expect(await new DoubaoLlm(() => config).summarize("做完了")).toBe("好的");
    } finally {
      globalThis.fetch = original;
    }
    expect(seen[0]?.url).toBe("https://relay.test/v1/voice/chat/completions");
    expect(seen[0]?.headers.Authorization).toBe("DPoP token");
  });
});
