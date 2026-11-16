import type { FwaiAccountSession } from "@t3tools/client-runtime/account";
import {
  createCloudAccountService,
  ManagedRelay,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readAccountToken: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readAccountToken,
  });
}

const managedRelayAccountService = createCloudAccountService<FwaiAccountSession>({
  deactivate: deactivateManagedRelayAuthentication,
  detach: deactivateManagedRelayAuthentication,
  cleanUp: async () => {
    const results = await Promise.all([
      runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
        reportFailure: false,
        reportDefect: false,
      }),
      settleAsyncResult(() =>
        runtime.runPromiseExit(
          ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
        ),
      ),
    ]);
    for (const result of results) {
      reportAtomCommandResult(result, { label: "cloud account cleanup" });
    }
  },
  activate: ({ source, accountId }) =>
    activateManagedRelayAuthentication(accountId, () => source.getAccessToken()),
});

/** Lets the relay act for the signed-in account until the returned function runs. */
export function attachManagedRelayAccount(session: FwaiAccountSession): () => void {
  return managedRelayAccountService.attach(session);
}
