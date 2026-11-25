import { RegistryContext } from "@effect/atom-react";
import type { SecretRequestItem } from "@t3tools/client-runtime/secret-request";
import type {
  EnvironmentId,
  ProjectId,
  VaultEntryId,
  VaultEntrySummary,
  VaultMatchesForRequestResult,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const testState = vi.hoisted(() => ({
  matches: null as unknown,
  answer: vi.fn(),
}));

vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      vaultMatchesForRequest: {
        ...actual.serverEnvironment.vaultMatchesForRequest,
        permissionAtom: (() => Atom.make(true)) as never,
      },
      answerVaultApproval: {
        ...actual.serverEnvironment.answerVaultApproval,
        permissionAtom: (() => Atom.make(true)) as never,
      },
    },
  };
});
vi.mock(import("~/state/sharing"), async (original) => ({
  ...(await original()),
  isSharedEnvironmentAtom: (() => Atom.make(false)) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: (() => ({ projectId: "project-b", title: "Deploy staging" })) as never,
  useProjects: (() => [
    { environmentId: "env-1", id: "project-a", title: "Marketing site" },
    { environmentId: "env-1", id: "project-b", title: "Web app" },
  ]) as never,
}));
vi.mock(import("../sharing/colleagues"), async (original) => ({
  ...(await original()),
  useColleagueName: (() => "Bob") as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("~/state/server");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.vaultMatchesForRequest
        ? async () => ({ _tag: "Success", value: testState.matches })
        : testState.answer) as never,
  };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { SecretRequestCard } from "./SecretRequestCard";

const environmentId = "env-1" as EnvironmentId;

function entry(id: string, overrides: Partial<VaultEntrySummary> = {}): VaultEntrySummary {
  return {
    id: id as VaultEntryId,
    name: id,
    kind: "password",
    domains: ["example.com"],
    scope: "global",
    version: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function setup(matches: VaultMatchesForRequestResult, itemId: string) {
  testState.matches = matches;
  testState.answer.mockReset();
  testState.answer.mockResolvedValue({ _tag: "Success", value: undefined });
  const item = {
    type: "secret_request",
    id: itemId,
    threadId: "thread-1",
    label: "Staging password",
    reason: "",
    secretStatus: "pending",
  } as unknown as SecretRequestItem;
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <SecretRequestCard environmentId={environmentId} item={item} visibility="local" />
    </RegistryContext.Provider>
  );
}

const answerOf = () => testState.answer.mock.calls[0]?.[0]?.input?.answer;

describe("SecretRequestCard vault matches", () => {
  it("answers with a matching entry, and adds the project for one scoped elsewhere", async () => {
    const element = setup(
      {
        matches: [
          {
            entry: entry("staging-admin", { username: "admin" }),
            matchedBy: "domain",
            inScope: true,
          },
          {
            entry: entry("marketing-admin", {
              scope: { projects: ["project-a" as ProjectId] },
            }),
            matchedBy: "name",
            inScope: false,
          },
        ],
        suggestedDomains: [],
      },
      "item-matches",
    );
    await using screen = await render(element);

    await expect.element(screen.getByText("Marketing site", { exact: false })).toBeVisible();
    await expect.element(screen.getByText("Save to vault")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(answerOf()).toEqual({ type: "vault", entryId: "staging-admin" });

    testState.answer.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Also allow in Web app" }));
    expect(answerOf()).toEqual({
      type: "vault",
      entryId: "marketing-admin",
      alsoAllowProject: true,
    });
  });

  it("keeps a typed value in the vault with the suggested name and domains", async () => {
    const element = setup(
      { matches: [], suggestedName: "Staging", suggestedDomains: ["staging.example.com"] },
      "item-save",
    );
    await using screen = await render(element);

    await userEvent.click(screen.getByText("Save to vault"));
    await expect.element(screen.getByLabelText("Name")).toHaveValue("Staging");
    await userEvent.click(screen.getByRole("button", { name: "Web app" }));
    await userEvent.type(screen.getByLabelText("Staging password"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Save securely" }));

    expect(answerOf()).toEqual({
      type: "save",
      secret: "hunter2",
      saveToVault: {
        name: "Staging",
        kind: "password",
        domains: ["staging.example.com"],
        scope: { projects: ["project-b"] },
      },
    });
  });
});

describe("SecretRequestCard vault approval", () => {
  function approvalCard(itemId: string) {
    testState.matches = { matches: [], suggestedDomains: [] };
    testState.answer.mockReset();
    testState.answer.mockResolvedValue({ _tag: "Success", value: undefined });
    const item = {
      type: "secret_request",
      id: itemId,
      threadId: "thread-1",
      label: "Staging",
      reason: "",
      secretStatus: "pending",
      vault: { entryId: "entry-staging", entryName: "Staging", requestedByAccountId: "acct-bob" },
    } as unknown as SecretRequestItem;
    return (
      <RegistryContext.Provider value={appAtomRegistry}>
        <SecretRequestCard environmentId={environmentId} item={item} visibility="local" />
      </RegistryContext.Provider>
    );
  }

  it("lets the owner allow one use, without asking for a value", async () => {
    await using screen = await render(approvalCard("item-approval"));

    await expect
      .element(screen.getByText("Bob wants to use Staging in Deploy staging"))
      .toBeVisible();
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Save to vault")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allow once" }));

    expect(testState.answer).toHaveBeenCalledTimes(1);
    expect(testState.answer.mock.calls[0]?.[0]).toEqual({
      environmentId,
      input: { threadId: "thread-1", turnItemId: "item-approval", decision: "allow" },
    });
  });
});
