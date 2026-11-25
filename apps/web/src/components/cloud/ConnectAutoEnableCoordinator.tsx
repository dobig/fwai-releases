import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthRelayReadScope, AuthRelayWriteScope, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import {
  CONNECT_AUTO_ENABLE_OPT_OUT_STORAGE_KEY,
  ConnectAutoEnableOptOutSchema,
  EMPTY_CONNECT_AUTO_ENABLE_OPT_OUT_STATE,
  VAULT_JOIN_ON_LINK_STORAGE_KEY,
  VaultJoinOnLinkSchema,
} from "~/cloud/connectAutoEnable";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useFwaiAuth } from "~/fwaiAccount/useFwaiAccount";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";

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

  useJoinSecretSharingOnceLinked(linked ? environmentId : null);
  return null;
}

/** Applies the sign-in screen's "join secret sharing" choice once this environment is linked. */
function useJoinSecretSharingOnceLinked(linkedEnvironmentId: string | null) {
  const [pendingJoin, setPendingJoin] = useLocalStorage(
    VAULT_JOIN_ON_LINK_STORAGE_KEY,
    false,
    VaultJoinOnLinkSchema,
  );
  const join = useAtomCommand(serverEnvironment.joinVaultSync, { reportFailure: false });
  const environmentId =
    linkedEnvironmentId === null ? null : EnvironmentId.make(linkedEnvironmentId);
  const canJoin = useAtomValue(serverEnvironment.joinVaultSync.permissionAtom(environmentId));

  // oxlint-disable-next-line t3code/react-effect-budget -- joining is an async environment call started once the link the sign-in choice waited for exists.
  useEffect(() => {
    if (!pendingJoin || environmentId === null || !canJoin) return;
    setPendingJoin(false);
    void join({ environmentId, input: undefined }).then((result) => {
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not join secret sharing",
        description:
          failure instanceof Error && failure.message
            ? failure.message
            : "Join from Settings → Secrets.",
      });
    });
  }, [pendingJoin, environmentId, canJoin, join, setPendingJoin]);
}
