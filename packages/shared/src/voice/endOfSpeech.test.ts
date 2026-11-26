import { describe, expect, it } from "vite-plus/test";

import { ASR_SAMPLE_RATE } from "./config.ts";
import { EndOfSpeech, isLive } from "./endOfSpeech.ts";

function chunk(amplitude: number, seconds = 0.2): Uint8Array {
  const samples = new Int16Array(Math.round(ASR_SAMPLE_RATE * seconds));
  for (let i = 0; i < samples.length; i++)
    samples[i] = Math.trunc(amplitude * Math.sin((i * 2 * Math.PI * 220) / ASR_SAMPLE_RATE));
  return new Uint8Array(samples.buffer);
}

async function feedAll(detector: EndOfSpeech, amplitude: number, times: number) {
  const verdicts = [];
  for (let i = 0; i < times; i++) verdicts.push(await detector.feed(chunk(amplitude)));
  return verdicts;
}

describe("EndOfSpeech", () => {
  it("ends after a pause", async () => {
    const detector = new EndOfSpeech(null, 1);
    const verdicts = [
      ...(await feedAll(detector, 50, 3)), // room noise before speaking
      ...(await feedAll(detector, 3000, 5)),
      ...(await feedAll(detector, 60, 4)), // short pause: keep listening
    ];
    expect(verdicts).toEqual(Array(12).fill(null));
    expect(await detector.feed(chunk(60))).toBe("end");
    expect(detector.heardSpeech).toBe(true);
  });

  it("primed with the user's level, ignores quieter voices and keeps them from recognition", async () => {
    const detector = new EndOfSpeech(null, 1);
    detector.prime(3000);
    await feedAll(detector, 50, 2);
    await detector.feed(chunk(700)); // a video nearby: loud enough alone, far below the user
    expect(detector.heardSpeech).toBe(false);
    expect(detector.keepLast).toBe(false);
    await detector.feed(chunk(2800));
    expect(detector.heardSpeech).toBe(true);
    expect(detector.keepLast).toBe(true);
    await detector.feed(chunk(700)); // right after: a word tail, kept
    expect(detector.keepLast).toBe(true);
    await feedAll(detector, 700, 3); // past the hangover: not the user
    expect(detector.keepLast).toBe(false);
    expect(detector.voiceLevel).toBeGreaterThan(1500);
  });

  it("keeps everything when not primed", async () => {
    const detector = new EndOfSpeech(null, 1);
    await feedAll(detector, 50, 3);
    expect(detector.keepLast).toBe(true);
    expect(detector.voiceLevel).toBeNull();
  });

  it("gives up without speech", async () => {
    const detector = new EndOfSpeech(null, 2, 1);
    expect((await feedAll(detector, 80, 5)).at(-1)).toBe("timeout");
    expect(detector.heardSpeech).toBe(false);
  });

  it("counts the wait for a first word from the beep once the client says it was heard", async () => {
    const detector = new EndOfSpeech(null, 2, 1);
    expect((await feedAll(detector, 80, 4)).at(-1)).toBeNull(); // 0.8 s, before the beep is heard
    detector.restartStartTimeout();
    expect((await feedAll(detector, 80, 4)).at(-1)).toBeNull(); // 0.8 s from the beep
    expect(await detector.feed(chunk(80))).toBe("timeout"); // 1.0 s
  });

  it("does not restart the wait once the user is talking", async () => {
    const detector = new EndOfSpeech(null, 1, 1);
    await feedAll(detector, 50, 2); // room noise before speaking
    await feedAll(detector, 3000, 3);
    detector.restartStartTimeout();
    expect(detector.heardSpeech).toBe(true);
    expect((await feedAll(detector, 60, 5)).at(-1)).toBe("end"); // silence still ends the turn
  });

  it("counts quieter voices after the user speaks as quiet", async () => {
    const detector = new EndOfSpeech(null, 1);
    await feedAll(detector, 50, 3);
    expect(await feedAll(detector, 3000, 8)).toEqual(Array(8).fill(null));
    // someone talking nearby at a fifth of the user's level no longer keeps the turn open
    expect((await feedAll(detector, 600, 5)).at(-1)).toBe("end");
  });

  it("asks the voice model, not loudness, when there is one", async () => {
    const detector = new EndOfSpeech({ probability: async () => 0.1 }, 1, 1);
    expect((await feedAll(detector, 3000, 5)).at(-1)).toBe("timeout"); // loud, but no voice
  });

  it("skips dead air from a Bluetooth mode switch", () => {
    expect(isLive(new Uint8Array(6400))).toBe(false);
    expect(isLive(chunk(30))).toBe(true);
  });
});
