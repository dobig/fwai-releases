import { fwaiDesktopIdentity } from "@t3tools/shared/fwaiDesktopIdentity";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopBaseDir } from "./DesktopStatePaths.ts";

const resolve = (stage: "prod" | "staging", t3Home: Option.Option<string>) =>
  resolveDesktopBaseDir({
    homeDirectory: "/Users/alice",
    homeDirName: fwaiDesktopIdentity(stage).homeDirName,
    joinPath: (first, ...segments) => [first, ...segments].join("/"),
    t3Home,
  });

describe("resolveDesktopBaseDir", () => {
  it("defaults prod and staging to separate home directories", () => {
    expect(resolve("prod", Option.none())).toBe("/Users/alice/.fwai");
    expect(resolve("staging", Option.none())).toBe("/Users/alice/.fwai-staging");
  });

  it("lets an explicit T3CODE_HOME win for every stage", () => {
    expect(resolve("prod", Option.some("/data/fwai"))).toBe("/data/fwai");
    expect(resolve("staging", Option.some(" /data/fwai "))).toBe("/data/fwai");
    expect(resolve("staging", Option.some("  "))).toBe("/Users/alice/.fwai-staging");
  });
});
