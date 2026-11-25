import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  VAULT_SYNC_NOTICE,
  VAULT_SYNC_STATE_PRESENTATION,
  vaultSyncActions,
  vaultSyncConfirmations,
  vaultSyncEnvironmentRows,
  vaultSyncPendingLabel,
  vaultSyncProblemMessage,
  type VaultSyncAction,
  type VaultSyncConfirmation,
} from "@t3tools/client-runtime/vault";
import type { EnvironmentId, VaultSyncState, VaultSyncStatus } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const STATE_BADGES = {
  unavailable: "secondary",
  off: "secondary",
  waiting: "info",
  on: "success",
  needs_rejoin: "warning",
} as const satisfies Record<VaultSyncState, string>;

async function confirmSync(confirmation: VaultSyncConfirmation): Promise<boolean> {
  const prompt = `${confirmation.title}\n${confirmation.message}`;
  return (
    (await requestConfirmDialog(prompt, {
      variant: confirmation.destructive ? "destructive" : "default",
    })) ?? window.confirm(prompt)
  );
}

/** Sync of one environment's vault through fwai Connect. The environment does all the crypto. */
export function SecretsSyncSection({
  environmentId,
  onEntriesChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly onEntriesChanged: () => void;
}) {
  const options = { reportFailure: false };
  const readStatus = useAtomCommand(serverEnvironment.vaultSyncStatus, options);
  const join = useAtomCommand(serverEnvironment.joinVaultSync, options);
  const leave = useAtomCommand(serverEnvironment.leaveVaultSync, options);
  const turnOff = useAtomCommand(serverEnvironment.turnOffVaultSync, options);
  const rotate = useAtomCommand(serverEnvironment.rotateVaultSyncKey, options);
  const revoke = useAtomCommand(serverEnvironment.revokeVaultSyncEnvironment, options);
  const canManage = useAtomValue(serverEnvironment.joinVaultSync.permissionAtom(environmentId));
  const { environments } = useEnvironments();
  const [status, setStatus] = useState<VaultSyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<VaultSyncAction | null>(null);

  const applyStatus = (result: AtomCommandResult<VaultSyncStatus, unknown>) => {
    if (result._tag === "Success") {
      setStatus(result.value);
      setError(null);
    } else if (!isAtomCommandInterrupted(result)) {
      setError(errorMessage(squashAtomCommandFailure(result), "Could not read sync status."));
    }
  };
  const applyOnOpen = useEffectEvent(applyStatus);
  // oxlint-disable-next-line t3code/react-effect-budget -- reads the sync status from the chosen environment when it is shown
  useEffect(() => {
    void readStatus({ environmentId, input: undefined }).then(applyOnOpen);
  }, [readStatus, environmentId]);

  const run = async (
    action: VaultSyncAction,
    failureTitle: string,
    call: () => Promise<AtomCommandResult<VaultSyncStatus, unknown>>,
  ) => {
    setBusy(action);
    const result = await call();
    setBusy(null);
    if (result._tag === "Success") {
      setStatus(result.value);
      setError(null);
      onEntriesChanged();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: errorMessage(squashAtomCommandFailure(result), "Try again."),
      });
    }
  };
  const target = { environmentId, input: undefined };

  const labelOf = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label;
  const actions = status === null ? [] : vaultSyncActions(status.state);
  const disabled = !canManage || busy !== null;
  const presentation = status === null ? null : VAULT_SYNC_STATE_PRESENTATION[status.state];

  return (
    <SettingsSection {...searchableSetting("secrets-sync")}>
      {error !== null ? (
        <SettingsRow title="Could not read sync status" description={error} />
      ) : status === null || presentation === null ? null : (
        <>
          <SettingsRow
            title={
              <span className="flex items-center gap-2">
                Sync
                <Badge variant={STATE_BADGES[status.state]} size="sm">
                  {presentation.label}
                </Badge>
              </span>
            }
            description={VAULT_SYNC_NOTICE}
            status={
              [
                presentation.description,
                vaultSyncPendingLabel(status.pendingUploads),
                status.problem ? vaultSyncProblemMessage(status.problem) : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            control={
              actions.includes("join") ? (
                <Button
                  size="sm"
                  variant={status.state === "off" ? "default" : "outline"}
                  disabled={disabled}
                  onClick={() => void run("join", "Could not join sync", () => join(target))}
                >
                  {status.state === "off" ? "Sync secrets across your machines" : "Rejoin"}
                </Button>
              ) : null
            }
          />
          {status.state === "on"
            ? vaultSyncEnvironmentRows(status, labelOf).map((row) => (
                <SettingsRow
                  key={row.environmentId}
                  title={row.label}
                  description={row.detail}
                  control={
                    row.canRevoke ? (
                      <Button
                        size="xs"
                        variant="ghost-destructive"
                        disabled={disabled}
                        onClick={async () => {
                          if (!(await confirmSync(vaultSyncConfirmations.revoke(row.label))))
                            return;
                          await run("revoke", `Could not revoke ${row.label}`, () =>
                            revoke({ environmentId, input: { environmentId: row.environmentId } }),
                          );
                        }}
                      >
                        Revoke
                      </Button>
                    ) : null
                  }
                />
              ))
            : null}
          {actions.includes("rotate") ? (
            <SettingsRow
              title="Rotate key"
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={async () => {
                    if (!(await confirmSync(vaultSyncConfirmations.rotate))) return;
                    await run("rotate", "Could not rotate the key", () => rotate(target));
                  }}
                >
                  Rotate key
                </Button>
              }
            />
          ) : null}
          {actions.includes("leave") ? (
            <SettingsRow
              title="Stop syncing on this machine"
              description="Its entries stay here."
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void run("leave", "Could not stop syncing", () => leave(target))}
                >
                  Stop syncing
                </Button>
              }
            />
          ) : null}
          {actions.includes("turnOff") ? (
            <SettingsRow
              title="Turn off sync everywhere"
              control={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={disabled}
                  onClick={async () => {
                    if (!(await confirmSync(vaultSyncConfirmations.turnOff))) return;
                    await run("turnOff", "Could not turn off sync", () => turnOff(target));
                  }}
                >
                  Turn off
                </Button>
              }
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
