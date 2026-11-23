import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type { FwaiGatewayThreadRoute } from "@t3tools/client-runtime/fwai-gateway";
import type { FwaiGatewayThreadRoute } from "@t3tools/client-runtime/fwai-gateway";

/**
 * A Codex thread keeps the provider it started on. While fwai Gateway routes Codex, a thread that
 * started direct still goes direct; this says so, so the header never claims a route it doesn't use.
 */
export function FwaiGatewayThreadRouteTag({
  environmentId,
  route,
}: {
  readonly environmentId: EnvironmentId;
  readonly route: FwaiGatewayThreadRoute;
}) {
  const routesCodex = useEnvironmentSettings(
    environmentId,
    (settings) => settings.fwaiGatewayEnabled && settings.fwaiGatewayCodex,
  );
  if (!routesCodex || route !== "direct") return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="shrink-0" />}>
        <Badge variant="warning" size="sm">
          Direct · started before fwai Gateway
        </Badge>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        This Codex thread started without fwai Gateway and keeps going direct. New Codex threads use
        fwai Gateway.
      </TooltipPopup>
    </Tooltip>
  );
}
