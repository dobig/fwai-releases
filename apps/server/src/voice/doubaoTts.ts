// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off - plain-TS voice core, tested without an Effect runtime.
/**
 * Doubao TTS 2.0 over the HTTP chunked streaming endpoint: the response is a run of
 * JSON objects, each carrying a base64 chunk of 24 kHz mono s16le PCM in `data`, so
 * playback can start before synthesis finishes.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { doubaoAccess, type VoiceConfig } from "./config.ts";

export const TTS_SAMPLE_RATE = 24_000;
const FINISHED_CODE = 20_000_000;

class TtsError extends Error {}

export type Synthesize = (config: VoiceConfig, text: string) => AsyncIterable<Uint8Array>;

export async function* synthesize(config: VoiceConfig, text: string): AsyncIterable<Uint8Array> {
  const access = doubaoAccess(config);
  if (!access) throw new TtsError("语音合成没有可用的豆包配置");
  const response = await fetch(access.kind === "direct" ? config.ttsUrl : `${access.base}/tts`, {
    method: "POST",
    headers:
      access.kind === "direct"
        ? {
            "X-Api-Key": access.apiKey,
            "X-Api-Resource-Id": config.ttsResourceId,
            "X-Api-Request-Id": NodeCrypto.randomUUID(),
            "Content-Type": "application/json",
          }
        : { Authorization: `Bearer ${access.credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      user: { uid: "voice-pilot" },
      req_params: {
        text,
        speaker: config.ttsSpeaker,
        audio_params: {
          format: "pcm",
          sample_rate: TTS_SAMPLE_RATE,
          speech_rate: config.ttsSpeechRate,
        },
        additions: JSON.stringify({ disable_markdown_filter: false }),
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const logid = response.headers.get("X-Tt-Logid");
  if (!response.ok || response.body === null) {
    const detail = (await response.text()).slice(0, 300);
    throw new TtsError(`豆包语音合成 HTTP ${response.status}: ${detail} (logid=${logid})`);
  }
  const splitter = new JsonObjectSplitter();
  const decoder = new TextDecoder();
  for await (const piece of response.body) {
    for (const message of splitter.push(decoder.decode(piece, { stream: true }))) {
      const {
        code = 0,
        data,
        message: detail,
      } = message as { code?: number; data?: string; message?: string };
      if (code !== 0 && code !== FINISHED_CODE)
        throw new TtsError(`豆包语音合成出错 ${code}: ${detail} (logid=${logid})`);
      if (data) yield Buffer.from(data, "base64");
    }
  }
}

/** Splits a stream of concatenated JSON objects ("{...}{...}") as the text arrives. */
export class JsonObjectSplitter {
  private buffer = "";

  push(text: string): Array<unknown> {
    this.buffer += text;
    const objects: Array<unknown> = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    let consumed = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (char === "}" && depth > 0 && --depth === 0) {
        objects.push(JSON.parse(this.buffer.slice(start, i + 1)));
        consumed = i + 1;
      }
    }
    this.buffer = this.buffer.slice(consumed);
    return objects;
  }
}
// "没有新通知。", "数据生产有新通知。" come back again and again; each costs 0.7-1 s before
// the first sound, and quota. Short lines are kept on disk as PCM.

const CACHE_MAX_CHARS = 24;
const CACHE_MAX_FILES = 500;
const CACHE_SLICE = 9_600; // bytes per yielded chunk (0.2 s), like a live stream

export class TtsCache {
  private readonly dir: string;
  private readonly synth: Synthesize;

  constructor(dir: string, synth: Synthesize = synthesize) {
    this.dir = dir;
    this.synth = synth;
  }

  private path(config: VoiceConfig, text: string): string {
    const key = NodeCrypto.createHash("sha1")
      .update(`${config.ttsSpeaker}|${config.ttsSpeechRate}|${text}`)
      .digest("hex");
    return NodePath.join(this.dir, `${key}.pcm`);
  }

  /** Like `synthesize`, but short lines come from (and go to) the on-disk cache. */
  async *speak(config: VoiceConfig, text: string): AsyncIterable<Uint8Array> {
    if (text.length > CACHE_MAX_CHARS) {
      yield* this.synth(config, text);
      return;
    }
    const path = this.path(config, text);
    const cached = await NodeFSP.readFile(path).catch(() => null);
    if (cached) {
      const now = new Date();
      await NodeFSP.utimes(path, now, now).catch(() => {}); // most recently used, for pruning
      for (let start = 0; start < cached.length; start += CACHE_SLICE)
        yield cached.subarray(start, start + CACHE_SLICE);
      return;
    }
    const chunks: Array<Uint8Array> = [];
    for await (const chunk of this.synth(config, text)) {
      chunks.push(chunk);
      yield chunk;
    }
    await this.store(path, Buffer.concat(chunks));
  }

  private async store(path: string, pcm: Buffer): Promise<void> {
    if (pcm.length === 0) return;
    await NodeFSP.mkdir(this.dir, { recursive: true });
    const tmp = `${path}.tmp`;
    await NodeFSP.writeFile(tmp, pcm);
    await NodeFSP.rename(tmp, path); // never a half-written file under the real name
    const names = (await NodeFSP.readdir(this.dir)).filter((name) => name.endsWith(".pcm"));
    if (names.length <= CACHE_MAX_FILES) return;
    const aged = await Promise.all(
      names.map(async (name) => ({
        name,
        mtime: (await NodeFSP.stat(NodePath.join(this.dir, name))).mtimeMs,
      })),
    );
    aged.sort((a, b) => a.mtime - b.mtime);
    await Promise.all(
      aged
        .slice(0, aged.length - CACHE_MAX_FILES)
        .map(({ name }) => NodeFSP.unlink(NodePath.join(this.dir, name)).catch(() => {})),
    );
  }

  /** Fill the cache in the background so even the first use is instant. */
  async prewarm(config: VoiceConfig, texts: ReadonlyArray<string>): Promise<void> {
    for (const text of new Set(texts)) {
      if (text.length > CACHE_MAX_CHARS) continue;
      if (
        await NodeFSP.stat(this.path(config, text)).then(
          () => true,
          () => false,
        )
      )
        continue;
      try {
        for await (const _ of this.speak(config, text)) {
          // drain
        }
      } catch {
        // a warm cache is nice to have, not required
      }
    }
  }
}
