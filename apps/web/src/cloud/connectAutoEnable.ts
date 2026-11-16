import * as Schema from "effect/Schema";

// fwai: the desktop app links its environment on sign-in. Turning fwai Connect off records the
// account here so the next launch leaves it off; the server cannot tell "never linked" from "unlinked".
export const CONNECT_AUTO_ENABLE_OPT_OUT_STORAGE_KEY = "fwai:connect-auto-enable-opt-out:v1";

export const ConnectAutoEnableOptOutSchema = Schema.Struct({
  optOutAccounts: Schema.Array(Schema.String),
});

export type ConnectAutoEnableOptOutState = typeof ConnectAutoEnableOptOutSchema.Type;

export const EMPTY_CONNECT_AUTO_ENABLE_OPT_OUT_STATE: ConnectAutoEnableOptOutState = {
  optOutAccounts: [],
};

export function withConnectAutoEnableOptOut(
  state: ConnectAutoEnableOptOutState,
  account: string,
  optedOut: boolean,
): ConnectAutoEnableOptOutState {
  const others = state.optOutAccounts.filter((entry) => entry !== account);
  return { optOutAccounts: optedOut ? [...others, account] : others };
}
