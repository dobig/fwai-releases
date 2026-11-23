import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useFwaiGatewayRouting } from "../../fwaiGateway/useFwaiGatewayRouting";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";

type RoutedDriver = "claudeAgent" | "codex";

interface Props {
  readonly environmentId: EnvironmentId | null;
  readonly driverKind: ProviderDriverKind | null | undefined;
}

const routedDriver = (driverKind: Props["driverKind"]): RoutedDriver | null =>
  driverKind === "claudeAgent" ? "claudeAgent" : driverKind === "codex" ? "codex" : null;

/** Shown beside the model while the selected provider goes through fwai Gateway. */
export function FwaiGatewayRouteBadge({ environmentId, driverKind }: Props) {
  const driver = routedDriver(driverKind);
  if (environmentId === null || driver === null) return null;
  return <RouteBadge environmentId={environmentId} driver={driver} />;
}

function RouteBadge({
  environmentId,
  driver,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: RoutedDriver;
}) {
  const routed = useEnvironmentSettings(
    environmentId,
    (settings) =>
      settings.fwaiGatewayEnabled &&
      (driver === "claudeAgent" ? settings.fwaiGatewayClaude : settings.fwaiGatewayCodex),
  );
  if (!routed) return null;
  return (
    <Badge variant="info" size="sm">
      fwai
    </Badge>
  );
}

/** The selected provider's fwai Gateway switch, at the bottom of the model menu. */
export function FwaiGatewayPickerControl({ environmentId, driverKind }: Props) {
  const driver = routedDriver(driverKind);
  if (environmentId === null || driver === null) return null;
  return <FwaiGatewayPickerSwitch environmentId={environmentId} driver={driver} />;
}

function FwaiGatewayPickerSwitch({
  environmentId,
  driver,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: RoutedDriver;
}) {
  const routing = useFwaiGatewayRouting(environmentId);
  // Off, the gateway is turned on from the sidebar or Settings; the menu only refines it.
  if (!routing.canManage || !routing.enabled) return null;
  const name = driver === "claudeAgent" ? "Claude" : "Codex";
  return (
    <div className="flex items-center justify-between gap-4 border-t px-3 py-2">
      <span className="min-w-0 text-xs text-muted-foreground">
        <span className="block text-foreground">Route {name} through fwai Gateway</span>
        {routing.status ? <span className="block truncate">{routing.status}</span> : null}
      </span>
      <Switch
        size="sm"
        checked={routing.routesDriver(driver)}
        disabled={routing.busy || routing.unavailableReason !== null}
        aria-label={`Route ${name} through fwai Gateway`}
        onCheckedChange={(checked) => void routing.setProviderEnabled(driver, Boolean(checked))}
      />
    </div>
  );
}
