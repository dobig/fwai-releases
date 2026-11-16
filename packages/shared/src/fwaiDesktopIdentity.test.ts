import { describe, expect, it } from "vite-plus/test";

import { fwaiDesktopIdentity, parseFwaiStage } from "./fwaiDesktopIdentity.ts";

describe("fwai desktop identity", () => {
  it("treats an unset or empty stage as prod so unstaged builds keep today's names", () => {
    expect(parseFwaiStage(undefined)).toBe("prod");
    expect(parseFwaiStage("  ")).toBe("prod");
    expect(parseFwaiStage("prod")).toBe("prod");
    expect(parseFwaiStage(" staging ")).toBe("staging");
    expect(() => parseFwaiStage("Staging")).toThrow(/T3CODE_FWAI_STAGE/u);
  });

  it("keeps prod's installed names", () => {
    const prod = fwaiDesktopIdentity("prod");
    expect(prod.appId).toBe("com.fwaii.code");
    expect(prod.productName).toBeUndefined();
    expect(prod.scheme).toBe("fwai");
    expect(prod.packagedSchemes).toEqual(["fwai", "fwai-dev"]);
    expect(prod.homeDirName).toBe(".fwai");
    expect(prod.userDataDirName).toBe("fwai");
    expect(prod.commandName).toBe("fwai");
    expect(prod.linuxDesktopEntryName).toBe("com.fwaii.Code.desktop");
  });

  it("gives staging a name of its own everywhere prod has one", () => {
    const prod = fwaiDesktopIdentity("prod");
    const staging = fwaiDesktopIdentity("staging");
    expect(staging.appId).toBe("com.fwaii.code.staging");
    expect(staging.productName).toBe("fwai Staging");
    expect(staging.scheme).toBe("fwai-staging");
    expect(staging.homeDirName).toBe(".fwai-staging");
    for (const key of [
      "appId",
      "scheme",
      "homeDirName",
      "userDataDirName",
      "commandName",
      "linuxDesktopEntryName",
    ] as const) {
      expect(staging[key]).not.toBe(prod[key]);
    }
    expect(staging.packagedSchemes.some((scheme) => prod.packagedSchemes.includes(scheme))).toBe(
      false,
    );
  });
});
