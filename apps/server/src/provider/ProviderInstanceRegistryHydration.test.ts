import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const projectId = ProjectId.make("project-a");
const instanceId = ProviderInstanceId.make("codex_work");

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("deriveProviderInstanceConfigMap", () => {
  it("turns a machine-disabled instance on when a project enables it", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex"), enabled: true });
  });

  it("clears a nested config.enabled:false flag when a project enables the instance", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: false },
        },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { enabled: true },
    });
  });

  it("does not revive an instance a project override references but settings no longer configure", () => {
    const settings = settingsWith({
      providerInstances: {},
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBeUndefined();
  });

  it("ignores a project override that disables an instance, leaving the machine's config in charge", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBe(settings.providerInstances[instanceId]);
  });

  it("marks Claude and Codex instances for fwai Gateway routing only while it is on", () => {
    const managed = ProviderInstanceId.make("codex_managed");
    const userEnv = { name: "FOO", value: "bar", sensitive: false };
    const base = {
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), environment: [userEnv] },
        [managed]: { driver: ProviderDriverKind.make("codex"), config: { setupMode: "managed" } },
      },
    };
    const routeEnv = { name: "T3CODE_FWAI_GATEWAY_ROUTE", value: "1", sensitive: false };

    const off = deriveProviderInstanceConfigMap(settingsWith(base));
    const on = deriveProviderInstanceConfigMap(settingsWith({ ...base, fwaiGatewayEnabled: true }));

    expect(off[instanceId]?.environment).toEqual([userEnv]);
    expect(on[instanceId]?.environment).toEqual([userEnv, routeEnv]);
    expect(on[ProviderInstanceId.make("claudeAgent")]?.environment).toEqual([routeEnv]);
    expect(on[managed]?.environment).toBeUndefined();

    const claudeOnly = deriveProviderInstanceConfigMap(
      settingsWith({ ...base, fwaiGatewayEnabled: true, fwaiGatewayCodex: false }),
    );
    expect(claudeOnly[instanceId]?.environment).toEqual([userEnv]);
    expect(claudeOnly[ProviderInstanceId.make("claudeAgent")]?.environment).toEqual([routeEnv]);

    const withProject = deriveProviderInstanceConfigMap(
      settingsWith({ ...base, fwaiGatewayEnabled: true, fwaiGatewayProjectId: "proj-a" }),
    );
    expect(withProject[ProviderInstanceId.make("claudeAgent")]?.environment).toEqual([
      routeEnv,
      { name: "T3CODE_FWAI_GATEWAY_PROJECT", value: "proj-a", sensitive: false },
    ]);
  });
});
