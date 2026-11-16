import { fwaiAccessPermitsUse, type FwaiAccountSession } from "@t3tools/client-runtime/account";
import { type ReactNode, useEffect, useState } from "react";

import { attachManagedRelayAccount } from "../cloud/managedAuth";
import { isGuestPage } from "../guestPage";
import {
  FwaiAccountLoadingScreen,
  FwaiSignInCodeScreen,
  FwaiSignInScreen,
  FwaiSubscriptionRequiredScreen,
} from "./FwaiAccountScreens";
import { getFwaiAccountSession } from "./session";
import { useFwaiAccount } from "./useFwaiAccount";

/** Loaded only when this build and origin have account features; gates the whole app on sign-in. */
export default function FwaiAccountShell({ children }: { readonly children: ReactNode }) {
  const session = getFwaiAccountSession();
  if (!session) return children;
  return <FwaiAccountGate session={session}>{children}</FwaiAccountGate>;
}

function FwaiAccountGate({
  session,
  children,
}: {
  readonly session: FwaiAccountSession;
  readonly children: ReactNode;
}) {
  // oxlint-disable-next-line t3code/react-effect-budget -- binds the relay to the account session for the app's lifetime
  useEffect(() => {
    const detach = attachManagedRelayAccount(session);
    void session.start();
    return detach;
  }, [session]);

  // oxlint-disable-next-line t3code/react-effect-budget -- re-checks fwai access when the app returns to the foreground
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState === "visible") void session.checkAccess();
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [session]);

  const state = useFwaiAccount();
  // Guests open shared threads without an account.
  const [guestPage] = useState(isGuestPage);
  // A restored session opens the app while its first access check runs; a fresh
  // sign-in waits for it so an account without access never sees the app.
  const [signedInHere, setSignedInHere] = useState(false);
  if (!signedInHere && (state.status === "signedOut" || state.status === "codeRequired")) {
    setSignedInHere(true);
  }

  if (guestPage) return children;
  switch (state.status) {
    case "loading":
      return <FwaiAccountLoadingScreen />;
    case "signedOut":
      return <FwaiSignInScreen session={session} error={state.error} />;
    case "codeRequired":
      return (
        <FwaiSignInCodeScreen
          session={session}
          emailHint={state.emailHint}
          codeSent={state.codeSent}
          error={state.error}
        />
      );
    case "signedIn":
      if (!fwaiAccessPermitsUse(state.access)) {
        return <FwaiSubscriptionRequiredScreen session={session} user={state.user} />;
      }
      if (state.access === "checking" && signedInHere) return <FwaiAccountLoadingScreen />;
      return children;
  }
}
