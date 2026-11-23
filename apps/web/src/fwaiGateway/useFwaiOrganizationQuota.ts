import { useEffect, useState } from "react";

import { type FwaiOrganizationQuota, fetchFwaiOrganizationQuota } from "../fwaiAccount/session";

let cached: FwaiOrganizationQuota | null = null;

/** The organization's projects and quota while `active`; null for accounts outside one. */
export function useFwaiOrganizationQuota(active: boolean): FwaiOrganizationQuota | null {
  const [quota, setQuota] = useState<FwaiOrganizationQuota | null>(cached);
  // oxlint-disable-next-line t3code/react-effect-budget -- reads project quota from the gateway while routing is on
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetchFwaiOrganizationQuota().then((next) => {
      cached = next;
      if (!cancelled) setQuota(next);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return active ? quota : null;
}

export function formatProjectQuota(project: {
  readonly fiveHourPercent: number | null;
  readonly weeklyPercent: number | null;
}): string | null {
  const parts = [
    project.fiveHourPercent === null ? null : `5h ${Math.round(project.fiveHourPercent)}%`,
    project.weeklyPercent === null ? null : `week ${Math.round(project.weeklyPercent)}%`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}
