import { AuthRelayReadScope, AuthRelayWriteScope, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import {
  CONNECT_AUTO_ENABLE_OPT_OUT_STORAGE_KEY,
  ConnectAutoEnableOptOutSchema,
  EMPTY_CONNECT_AUTO_ENABLE_OPT_OUT_STATE,
} from "~/cloud/connectAutoEnable";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useFwaiAuth } from "~/fwaiAccount/useFwaiAccount";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readEnvironmentScope } from "~/state/session";

/**
 * fwai: links the desktop app's environment to fwai Connect once its account is signed in,
 * so the computer shows up on the web and mobile clients without visiting Settings.
 * Skipped when the user turned Connect off or the relay revoked the link.
 */
export function ConnectAutoEnableCoordinator() {
  const { isSignedIn, userId } = useFwaiAuth();
  const { linkState, linked, linkRevoked, reconcileCloudState } = useCloudLinkController();
  const [optOutState] = useLocalStorage(
    CONNECT_AUTO_ENABLE_OPT_OUT_STORAGE_KEY,
    EMPTY_CONNECT_AUTO_ENABLE_OPT_OUT_STATE,
    ConnectAutoEnableOptOutSchema,
  );
  // One attempt per account and environment per launch; a failure is reported once and
  // the Settings switch stays available to retry.
  const attempted = useRef(new Set<string>());

  const environmentId = linkState.target?.environmentId ?? null;
  const optedOut = userId !== null && optOutState.optOutAccounts.includes(userId);
  const ready =
    hasCloudPublicConfig() &&
    isSignedIn === true &&
    userId !== null &&
    environmentId !== null &&
    linkState.data !== null &&
    !linkState.isPending &&
    !linked &&
    !linkRevoked &&
    !optedOut;

  // oxlint-disable-next-line t3code/react-effect-budget -- linking is an async relay call started when sign-in and link state become ready, not render-derived state.
  useEffect(() => {
    if (!ready || userId === null || environmentId === null) return;
    const id = EnvironmentId.make(environmentId);
    if (
      !readEnvironmentScope(id, AuthRelayReadScope) ||
      !readEnvironmentScope(id, AuthRelayWriteScope)
    ) {
      return;
    }
    const key = `${userId}:${environmentId}`;
    if (attempted.current.has(key)) return;
    attempted.current.add(key);
    void reconcileCloudState({
      managedTunnel: true,
      publish: true,
      installRelayClientWithoutConfirmation: true,
    });
  }, [ready, userId, environmentId, reconcileCloudState]);

  return null;
}
