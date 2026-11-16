import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_CONNECT_AUTO_ENABLE_OPT_OUT_STATE,
  withConnectAutoEnableOptOut,
} from "./connectAutoEnable.ts";

describe("withConnectAutoEnableOptOut", () => {
  it("records an account that turned fwai Connect off once", () => {
    const once = withConnectAutoEnableOptOut(EMPTY_CONNECT_AUTO_ENABLE_OPT_OUT_STATE, "a", true);
    expect(withConnectAutoEnableOptOut(once, "a", true)).toEqual({ optOutAccounts: ["a"] });
  });

  it("clears the account when fwai Connect is turned back on", () => {
    const state = { optOutAccounts: ["a", "b"] };
    expect(withConnectAutoEnableOptOut(state, "a", false)).toEqual({ optOutAccounts: ["b"] });
  });
});
