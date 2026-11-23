import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useFwaiAccount } from "../fwaiAccount/useFwaiAccount";
import { approveFwaiDeviceCode } from "../fwaiAccount/session";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: true };

export const CODEX_GATEWAY_PROVIDER_ID = "fwai_gateway";

/**
 * The fwai Gateway switch for one environment. Turning it on signs the environment in with the
 * account this app is already signed in to (it approves the environment's device code itself);
 * turning it off signs the environment out again.
 */
export function useFwaiGatewayRouting(environmentId: EnvironmentId) {
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const account = useFwaiAccount();
  const enabled = useEnvironmentSettings(environmentId, (settings) => settings.fwaiGatewayEnabled);
  const claude = useEnvironmentSettings(environmentId, (settings) => settings.fwaiGatewayClaude);
  const codex = useEnvironmentSettings(environmentId, (settings) => settings.fwaiGatewayCodex);
  const defaultProjectId = useEnvironmentSettings(
    environmentId,
    (settings) => settings.fwaiGatewayProjectId,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const stateQuery = useEnvironmentQuery(
    canManage ? serverEnvironment.fwaiGatewayState({ environmentId, input: {} }) : null,
  );
  const connect = useAtomCommand(serverEnvironment.fwaiGatewayConnect, COMMAND_OPTIONS);
  const disconnect = useAtomCommand(serverEnvironment.fwaiGatewayDisconnect, COMMAND_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = stateQuery.data;
  const signedIn = account.status === "signedIn";
  const request = { environmentId, input: {} };
  // Turning it off must stay possible even after the account signs out.
  const unavailableReason = !canManage
    ? "This session can't change this environment's providers."
    : !enabled && !signedIn
      ? "Sign in to fwai to use your plan here."
      : null;

  const setEnabled = async (next: boolean) => {
    if (busy || unavailableReason) return;
    setBusy(true);
    setError(null);
    try {
      if (!next) {
        // The server signs its gateway session out and clears the setting in one step.
        const result = await disconnect(request);
        if (result._tag === "Failure") updateSettings({ fwaiGatewayEnabled: false });
        return;
      }
      if (state?.status !== "connected") {
        const result = await connect(request);
        if (result._tag === "Failure") throw new Error("Could not start fwai Gateway sign-in.");
        await approveFwaiDeviceCode(result.value.userCode);
      }
      updateSettings({ fwaiGatewayEnabled: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not turn on fwai Gateway.");
    } finally {
      setBusy(false);
    }
  };

  const status = (() => {
    if (busy) return enabled ? "Turning off…" : "Connecting with your fwai account…";
    if (error) return error;
    if (unavailableReason) return unavailableReason;
    if (state?.status === "error") return state.message;
    if (enabled && state?.status === "pending") return "Connecting with your fwai account…";
    if (enabled && state?.status === "connected") {
      return state.username ? `Using ${state.username}'s fwai plan.` : "Using your fwai plan.";
    }
    return null;
  })();

  /** Routes one provider; turning one on while routing is off turns routing on for it alone. */
  const setProviderEnabled = async (driver: "claudeAgent" | "codex", next: boolean) => {
    const patch =
      driver === "claudeAgent" ? { fwaiGatewayClaude: next } : { fwaiGatewayCodex: next };
    if (next && !enabled) {
      updateSettings(
        driver === "claudeAgent"
          ? { fwaiGatewayClaude: true, fwaiGatewayCodex: false }
          : { fwaiGatewayClaude: false, fwaiGatewayCodex: true },
      );
      await setEnabled(true);
      return;
    }
    updateSettings(patch);
  };

  const routesDriver = (driver: string) =>
    enabled && ((driver === "claudeAgent" && claude) || (driver === "codex" && codex));

  return {
    canManage,
    enabled,
    claude,
    codex,
    defaultProjectId,
    setDefaultProjectId: (projectId: string | null) =>
      updateSettings({ fwaiGatewayProjectId: projectId }),
    setProviderEnabled,
    routesDriver,
    connected: state?.status === "connected",
    busy,
    unavailableReason,
    status,
    setEnabled,
  };
}
