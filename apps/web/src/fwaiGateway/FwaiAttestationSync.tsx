import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import { useContext, useEffect } from "react";

import { syncFwaiEnvironmentAttestation } from "../fwaiAccount/session";
import { useConnectedEnvironmentIds } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";

// Older environments lack these RPCs; a failure only means no attestation, never a toast.
const QUIET = { reportFailure: false, reportDefect: false } as const;

/**
 * Registers each connected environment's attestation key under the signed-in account
 * (llm_gateway#760). Keyed by account and connection, so it runs again on every reconnect.
 */
export function FwaiAttestationSync({ accountId }: { readonly accountId: string }) {
  const environmentIds = useConnectedEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <EnvironmentAttestationSync
      key={`${accountId}:${environmentId}`}
      environmentId={environmentId}
    />
  ));
}

function EnvironmentAttestationSync({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const registry = useContext(RegistryContext);
  // oxlint-disable-next-line t3code/react-effect-budget -- registers the environment's key with the gateway when it connects
  useEffect(() => {
    if (!canManage) return;
    void syncFwaiEnvironmentAttestation({
      registration: async () => {
        const result = await runAtomCommand(
          registry,
          serverEnvironment.fwaiAttestationRegistration,
          { environmentId, input: {} },
          QUIET,
        );
        return result._tag === "Success" ? result.value : null;
      },
      report: async (report) => {
        await runAtomCommand(
          registry,
          serverEnvironment.fwaiAttestationReport,
          { environmentId, input: report },
          QUIET,
        );
      },
    });
  }, [canManage, environmentId, registry]);
  return null;
}
