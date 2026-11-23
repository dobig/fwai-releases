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

export { formatProjectQuota } from "@t3tools/client-runtime/fwai-gateway";
