// @effect-diagnostics nodeBuiltinImport:off - plain-TS voice core, tested without an Effect runtime.
import * as NodeFS from "node:fs";

import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "@t3tools/shared/voice/config";

/** Where an environment server reaches the relay's voice routes. */
export const RELAY_VOICE_PATH = "/v1/environment/voice";

/**
 * `voice/config.json` in the server's state directory: any VoiceConfig field, in the
 * same names. T3CODE_FWAI_DOUBAO_API_KEY overrides the key so it can stay out of files.
 */
export function loadVoiceConfig(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): VoiceConfig {
  let file: Partial<VoiceConfig> = {};
  try {
    file = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Partial<VoiceConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const known = Object.fromEntries(
    Object.entries(file).filter(([key]) => key in DEFAULT_VOICE_CONFIG),
  );
  const config = { ...DEFAULT_VOICE_CONFIG, ...known } as VoiceConfig;
  const key = env.T3CODE_FWAI_DOUBAO_API_KEY?.trim();
  return key ? { ...config, doubaoApiKey: key } : config;
}
