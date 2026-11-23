import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { type FwaiPlanSummary, fetchFwaiPlanSummary } from "../../fwaiAccount/session";
import { useFwaiGatewayRouting } from "../../fwaiGateway/useFwaiGatewayRouting";
import {
  formatProjectQuota,
  useFwaiOrganizationQuota,
} from "../../fwaiGateway/useFwaiOrganizationQuota";
import { QuotaProjectSelect, projectName } from "../fwaiGateway/QuotaProjectSelect";
import { Switch } from "../ui/switch";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";

const DESCRIPTION =
  "Claude and Codex use your fwai plan instead of their own sign-in. Codex threads keep the route they started on.";

function formatPlan(plan: FwaiPlanSummary): string | null {
  const parts = [
    plan.planLabel === null ? null : `Plan ${plan.planLabel}`,
    plan.fiveHourPercent === null ? null : `5h ${Math.round(plan.fiveHourPercent)}%`,
    plan.weeklyPercent === null ? null : `week ${Math.round(plan.weeklyPercent)}%`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Routes this environment's Claude and Codex through fwai Gateway with the app's own account. */
export function FwaiGatewaySettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const routing = useFwaiGatewayRouting(environmentId);
  const active = routing.enabled && routing.connected;
  const quota = useFwaiOrganizationQuota(active);
  const [plan, setPlan] = useState<FwaiPlanSummary | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- reads plan and quota from the gateway while routing is on
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetchFwaiPlanSummary().then((summary) => {
      if (!cancelled) setPlan(summary);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  if (!routing.canManage) return null;

  // Organization members draw on a project's quota, not a personal plan.
  const defaultProject =
    quota === null
      ? null
      : quota.projects.find(
          (project) => project.id === (routing.defaultProjectId ?? quota.currentProjectId),
        );
  const statusText = !active
    ? null
    : quota !== null
      ? [
          quota.organizationName,
          defaultProject?.name,
          defaultProject && formatProjectQuota(defaultProject),
        ]
          .filter(Boolean)
          .join(" · ")
      : plan === null
        ? null
        : formatPlan(plan);
  const accountDefault = quota === null ? null : projectName(quota, quota.currentProjectId);

  return (
    <SettingsGroup>
      <SettingsRow
        title="Route through fwai Gateway"
        description={routing.status ?? DESCRIPTION}
        status={statusText || null}
        control={
          <Switch
            checked={routing.enabled}
            disabled={routing.busy || routing.unavailableReason !== null}
            aria-label="Route through fwai Gateway"
            onCheckedChange={(checked) => void routing.setEnabled(Boolean(checked))}
          />
        }
      />
      {routing.enabled ? (
        <>
          <SettingsRow
            title="Claude"
            description="Route Claude through fwai Gateway."
            control={
              <Switch
                checked={routing.claude}
                aria-label="Route Claude through fwai Gateway"
                onCheckedChange={(checked) =>
                  void routing.setProviderEnabled("claudeAgent", Boolean(checked))
                }
              />
            }
          />
          <SettingsRow
            title="Codex"
            description="Route new Codex threads through fwai Gateway. Existing threads keep their route."
            control={
              <Switch
                checked={routing.codex}
                aria-label="Route Codex through fwai Gateway"
                onCheckedChange={(checked) =>
                  void routing.setProviderEnabled("codex", Boolean(checked))
                }
              />
            }
          />
          {quota !== null && quota.projects.length > 0 ? (
            <SettingsRow
              title="Default quota project"
              description="Threads use this project's quota unless they pick their own in the thread card."
              control={
                <QuotaProjectSelect
                  quota={quota}
                  value={routing.defaultProjectId}
                  followLabel={
                    accountDefault ? `Account default (${accountDefault})` : "Account default"
                  }
                  onChange={routing.setDefaultProjectId}
                  ariaLabel="Default quota project"
                  className="w-full sm:w-56"
                />
              }
            />
          ) : null}
        </>
      ) : null}
    </SettingsGroup>
  );
}
