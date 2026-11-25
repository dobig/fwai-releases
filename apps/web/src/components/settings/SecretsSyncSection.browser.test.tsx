import { render } from "../../../test/render";
import type { EnvironmentId, VaultSyncStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const ENVIRONMENT = "env-this" as EnvironmentId;

const { commands, confirm } = vi.hoisted(() => {
  const on: VaultSyncStatus = {
    state: "on",
    environments: [
      {
        environmentId: "env-this" as never,
        isThis: true,
        hasKey: true,
        enrolledAt: "2026-11-01T00:00:00.000Z",
      },
      {
        environmentId: "env-other" as never,
        isThis: false,
        hasKey: true,
        enrolledAt: "2026-11-02T00:00:00.000Z",
      },
    ],
    pendingUploads: 0,
  };
  const off: VaultSyncStatus = { state: "off", environments: [], pendingUploads: 0 };
  return {
    commands: {
      vaultSyncStatus: vi.fn(async (_request: unknown) => ({
        _tag: "Success" as const,
        value: on,
      })),
      turnOffVaultSync: vi.fn(async (_request: unknown) => ({
        _tag: "Success" as const,
        value: off,
      })),
    },
    confirm: vi.fn(async (_message: string, _options?: unknown) => false),
  };
});

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = (name: string) => ({ name, permissionAtom: () => allowed });
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      vaultSyncStatus: command("vaultSyncStatus"),
      joinVaultSync: command("joinVaultSync"),
      leaveVaultSync: command("leaveVaultSync"),
      turnOffVaultSync: command("turnOffVaultSync"),
      rotateVaultSyncKey: command("rotateVaultSyncKey"),
      revokeVaultSyncEnvironment: command("revokeVaultSyncEnvironment"),
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly name: string }) =>
    commands[command.name as keyof typeof commands] ?? vi.fn()) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      { environmentId: "env-this", label: "Laptop" },
      { environmentId: "env-other", label: "Studio Mac" },
    ],
  })) as never,
}));
vi.mock(import("../../confirmDialog"), async (original) => ({
  ...(await original()),
  requestConfirmDialog: confirm as never,
}));

import { SecretsSyncSection } from "./SecretsSyncSection";

function setup() {
  commands.vaultSyncStatus.mockClear();
  commands.turnOffVaultSync.mockClear();
  confirm.mockReset();
}

describe("SecretsSyncSection", () => {
  it("turns sync off everywhere only after a destructive confirmation", async () => {
    setup();
    await using _screen = await render(
      <SecretsSyncSection environmentId={ENVIRONMENT} onEntriesChanged={() => {}} />,
    );
    await expect.element(page.getByText("Studio Mac")).toBeVisible();

    confirm.mockResolvedValueOnce(false);
    await userEvent.click(page.getByRole("button", { name: "Turn off" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Turn off sync everywhere?"), {
      variant: "destructive",
    });
    expect(commands.turnOffVaultSync).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    await userEvent.click(page.getByRole("button", { name: "Turn off" }));
    await expect
      .element(page.getByRole("switch", { name: "Share secrets with my other machines" }))
      .not.toBeChecked();
    expect(commands.turnOffVaultSync).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT,
      input: undefined,
    });
  });
});
