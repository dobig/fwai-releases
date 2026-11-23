// @effect-diagnostics nodeBuiltinImport:off - plain-TS voice core, tested without an Effect runtime.
/** The voice-activity model for end-of-speech on the server (Silero on onnxruntime-web). */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ASR_SAMPLE_RATE } from "@t3tools/shared/voice/config";
import type { SpeechDetector } from "@t3tools/shared/voice/endOfSpeech";

/**
 * Silero VAD v5 (MIT, silero_vad.onnx in ./assets) on onnxruntime-web's WASM build:
 * no native module to stage. Each session keeps recurrent state, so one per turn.
 */
export class SileroVad implements SpeechDetector {
  private state = new Float32Array(2 * 128);
  private context = new Float32Array(64); // v5 prepends the previous frame's last 64 samples

  private readonly ort: typeof import("onnxruntime-web");
  private readonly session: import("onnxruntime-web").InferenceSession;

  private constructor(
    ort: typeof import("onnxruntime-web"),
    session: import("onnxruntime-web").InferenceSession,
  ) {
    this.ort = ort;
    this.session = session;
  }

  static async load(): Promise<SileroVad> {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    const assets = voiceAssetsDir();
    if (NodeFS.existsSync(NodePath.join(assets, "ort-wasm-simd-threaded.wasm")))
      ort.env.wasm.wasmPaths = `${assets}/`;
    const model = await NodeFSP.readFile(NodePath.join(assets, "silero_vad.onnx"));
    return new SileroVad(ort, await ort.InferenceSession.create(model));
  }

  async probability(frame: Float32Array): Promise<number> {
    const input = new Float32Array(this.context.length + frame.length);
    input.set(this.context);
    input.set(frame, this.context.length);
    const result = await this.session.run({
      input: new this.ort.Tensor("float32", input, [1, input.length]),
      state: new this.ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: new this.ort.Tensor("int64", BigInt64Array.from([BigInt(ASR_SAMPLE_RATE)]), []),
    });
    this.state = new Float32Array(result.stateN!.data as Float32Array);
    this.context = frame.slice(-this.context.length);
    return (result.output!.data as Float32Array)[0] ?? 0;
  }
}

/** ./assets next to this module in source; the bundle copies it beside its own entry. */
export function voiceAssetsDir(): string {
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const candidates = [NodePath.join(here, "assets"), NodePath.join(here, "voice-assets")];
  return (
    candidates.find((dir) => NodeFS.existsSync(NodePath.join(dir, "silero_vad.onnx"))) ??
    candidates[0]!
  );
}

/** A fresh detector per turn, or null (loudness only) if the model can't load. */
export async function loadSpeechDetector(
  onError: (error: unknown) => void,
): Promise<SpeechDetector | null> {
  try {
    return await SileroVad.load();
  } catch (error) {
    onError(error);
    return null;
  }
}
