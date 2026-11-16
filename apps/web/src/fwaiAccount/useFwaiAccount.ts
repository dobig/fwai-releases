import type { FwaiAccountState } from "@t3tools/client-runtime/account";
import { useSyncExternalStore } from "react";

import { getFwaiAccountSession } from "./session";

const NO_ACCOUNT_STATE: FwaiAccountState = { status: "signedOut", error: null };
const subscribeToNothing = () => () => undefined;
const readNoAccountState = () => NO_ACCOUNT_STATE;

export function useFwaiAccount(): FwaiAccountState {
  const session = getFwaiAccountSession();
  return useSyncExternalStore(
    session?.subscribe ?? subscribeToNothing,
    session?.getState ?? readNoAccountState,
  );
}

const readAccessToken = async () => (await getFwaiAccountSession()?.getAccessToken()) ?? null;

/** The account in the shape the T3 Connect surfaces read. `isSignedIn` is undefined while loading. */
export function useFwaiAuth() {
  const state = useFwaiAccount();
  const isLoaded = state.status !== "loading";
  return {
    isLoaded,
    isSignedIn: isLoaded ? state.status === "signedIn" : undefined,
    userId: state.status === "signedIn" ? state.user.id : null,
    getToken: readAccessToken,
  };
}

/**
 * The account gate replaces the app with the sign-in screen whenever no one is
 * signed in, so the signed-out branches that call this never render.
 */
export function openFwaiSignIn(): void {}
