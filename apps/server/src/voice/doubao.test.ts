// @effect-diagnostics nodeBuiltinImport:off - plain-TS voice core, tested without an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";

import {
  AUDIO_ONLY_REQUEST,
  decodeFrame,
  encodeFrame,
  FLAG_LAST,
  FLAG_LAST_WITH_SEQUENCE,
  FLAG_SEQUENCE,
  FULL_SERVER_RESPONSE,
  isLast,
} from "@t3tools/shared/voice/asr";
import {
  DEFAULT_VOICE_CONFIG,
  doubaoAccess,
  type VoiceConfig,
  type VoiceRelay,
} from "@t3tools/shared/voice/config";
import { DoubaoLlm, extractJson } from "@t3tools/shared/voice/llm";
import { decodeBase64, JsonObjectSplitter } from "@t3tools/shared/voice/tts";

import { loadVoiceConfig } from "./config.ts";
import { transcribe } from "./doubaoAsr.ts";
import { synthesize, TtsCache } from "./doubaoTts.ts";

/** The environment's view of the relay: bearer credential on every call. */
const bearerRelay = (url: string, credential: string): VoiceRelay => ({
  base: `${url.replace(/\/+$/, "")}/v1/environment/voice`,
  authorize: async () => ({ Authorization: `Bearer ${credential}` }),
});

function serverFrame(payload: unknown, last: boolean): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.from([
    0x11,
    (FULL_SERVER_RESPONSE << 4) | (last ? FLAG_LAST_WITH_SEQUENCE : FLAG_SEQUENCE),
    0x10,
    0,
  ]);
  const numbers = Buffer.alloc(8);
  numbers.writeInt32BE(last ? -3 : 2, 0);
  numbers.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, numbers, body]);
}

describe("Doubao speech recognition frames", () => {
  it("lays out a client frame", () => {
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

    const message = Buffer.from("bad audio");
    const numbers = Buffer.alloc(8);
    numbers.writeUInt32BE(45000151, 0);
    numbers.writeUInt32BE(message.length, 4);
    const error = Buffer.concat([Buffer.from([0x11, 0xf0, 0x10, 0]), numbers, message]);
    expect(decodeFrame(error).error).toEqual({ code: 45000151, message: "bad audio" });
  });
});

describe("Doubao speech synthesis", () => {
  it("decodes base64 without Buffer", () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);
    expect([...decodeBase64(Buffer.from(bytes).toString("base64"))]).toEqual([...bytes]);
    expect([...decodeBase64("AQID")]).toEqual([1, 2, 3]);
  });

  it("splits concatenated JSON objects however the stream is cut", () => {
    const splitter = new JsonObjectSplitter();
    expect(splitter.push('{"code":0,"data":"a}{"}{"co')).toEqual([{ code: 0, data: "a}{" }]);
    expect(splitter.push('de":20000000}')).toEqual([{ code: 20000000 }]);
  });

  it("synthesizes short lines once, then plays them from disk", async () => {
    const calls: Array<string> = [];
    const cache = new TtsCache(
      NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-tts-")), "cache"),
      async function* (_config: VoiceConfig, text: string) {
        calls.push(text);
        yield new Uint8Array(200).fill(1);
        yield new Uint8Array(200).fill(2);
      },
    );
    const collect = async (text: string) => {
      const chunks: Array<Uint8Array> = [];
      for await (const chunk of cache.speak(DEFAULT_VOICE_CONFIG, text)) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    const first = await collect("没有新通知。");
    const second = await collect("没有新通知。");
    const long = "数据生产做完了。降强度实验已开跑，四题各四采样，预计四十到九十分钟出结果。";
    await collect(long);
    await collect(long);
    expect(second.equals(first)).toBe(true);
    expect(first.length).toBe(400);
    expect(calls.filter((t) => t === "没有新通知。")).toHaveLength(1);
    expect(calls).toHaveLength(3); // long lines are never cached
  });
});

describe("intent JSON", () => {
  it("tolerates wrapping and falls back to asking again", () => {
    expect(extractJson('```json\n{"action": "send", "session": 2}\n```').session).toBe(2);
    expect(extractJson("嗯？").action).toBe("none");
  });
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

/** A stand-in relay: TTS and chat over HTTP, ASR over a WebSocket. */
async function fakeRelay(): Promise<{ url: string; seen: Array<Seen>; close: () => void }> {
  const seen: Array<Seen> = [];
  const server = NodeHttp.createServer((request, response) => {
    const parts: Array<Buffer> = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(parts).toString("utf8"),
      });
      if (request.url?.endsWith("/tts")) {
        response.end(
          `{"code":0,"data":"${Buffer.from([1, 2, 3]).toString("base64")}"}{"code":20000000}`,
        );
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "好的" } }] }));
      }
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    seen.push({ method: "WS", url: request.url ?? "", headers: request.headers, body: "" });
    socket.on("message", (data: Buffer) => {
      if (isLast(decodeFrame(data))) socket.send(serverFrame({ result: { text: "你好" } }, true));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => {
      sockets.close();
      server.close();
    },
  };
}

describe("Doubao through the relay", () => {
  it("prefers a local key, else the relay, else nothing", () => {
    const relay = bearerRelay("https://relay.test/", "cred");
    expect(doubaoAccess({ ...DEFAULT_VOICE_CONFIG, doubaoApiKey: "k", relay })).toEqual({
      kind: "direct",
      apiKey: "k",
    });
    expect(doubaoAccess({ ...DEFAULT_VOICE_CONFIG, relay })).toMatchObject({
      kind: "relay",
      base: "https://relay.test/v1/environment/voice",
    });
    expect(doubaoAccess(DEFAULT_VOICE_CONFIG)).toBeNull();
  });

  it("never takes the relay from the config file", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-config-"));
    const path = NodePath.join(dir, "config.json");
    NodeFS.writeFileSync(
      path,
      JSON.stringify({ relay: { url: "https://evil.test", credential: "x" } }),
    );
    expect(loadVoiceConfig(path, {}).relay).toBeUndefined();
  });

  it("sends speech, synthesis and the LLM with the relay credential, not a key", async () => {
    const relay = await fakeRelay();
    try {
      const config: VoiceConfig = {
        ...DEFAULT_VOICE_CONFIG,
        relay: bearerRelay(relay.url, "cred"),
      };

      const audio: Array<Uint8Array> = [];
      for await (const chunk of synthesize(config, "你好")) audio.push(chunk);
      expect(Buffer.concat(audio).equals(Buffer.from([1, 2, 3]))).toBe(true);

      expect(await new DoubaoLlm(() => config).summarize("做完了")).toBe("好的");

      async function* mic() {
        yield new Uint8Array(320);
        yield new Uint8Array(320);
      }
      expect(await transcribe(config, mic())).toBe("你好");

      const [tts, chat, asr] = relay.seen;
      expect(tts).toMatchObject({ method: "POST", url: "/v1/environment/voice/tts" });
      expect(JSON.parse(tts!.body).req_params.text).toBe("你好");
      expect(chat).toMatchObject({ method: "POST", url: "/v1/environment/voice/chat/completions" });
      expect(asr).toMatchObject({ method: "WS", url: "/v1/environment/voice/asr" });
      for (const request of relay.seen) {
        expect(request.headers.authorization).toBe("Bearer cred");
        expect(request.headers["x-api-key"]).toBeUndefined();
      }
    } finally {
      relay.close();
    }
  });

  it("fails, rather than hearing nothing, when the connection closes before the last packet", async () => {
    const server = NodeHttp.createServer();
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => socket.close(1011, "upstream gone"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      async function* mic() {
        yield new Uint8Array(320);
      }
      await expect(
        transcribe(
          { ...DEFAULT_VOICE_CONFIG, relay: bearerRelay(`http://127.0.0.1:${port}`, "c") },
          mic(),
        ),
      ).rejects.toThrow(/提前关闭/);
    } finally {
      sockets.close();
      server.close();
    }
  });
});
