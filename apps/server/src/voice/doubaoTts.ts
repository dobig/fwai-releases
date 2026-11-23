// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off - plain-TS voice core, tested without an Effect runtime.
/** Doubao TTS on the server: Node's fetch, plus an on-disk cache of short lines. */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { VoiceConfig } from "@t3tools/shared/voice/config";
import { makeSynthesize, type Synthesize } from "@t3tools/shared/voice/tts";

export const synthesize: Synthesize = makeSynthesize(
  (url, init) => fetch(url, init),
  () => NodeCrypto.randomUUID(),
);

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
