import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useFwaiGatewayRouting } from "../../fwaiGateway/useFwaiGatewayRouting";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** One-click fwai Gateway switch for this device's environment, above the sidebar utilities. */
export function SidebarFwaiGatewayToggle() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return <Toggle environmentId={environmentId} />;
}

function Toggle({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const routing = useFwaiGatewayRouting(environmentId);
  const navigate = useNavigate();
  if (!routing.canManage) return null;
  const detail =
    routing.status ??
    (routing.enabled
      ? "Claude and Codex use your fwai plan."
      : "Using each provider's own sign-in.");
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="min-w-0 cursor-pointer text-left text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void navigate({ to: "/settings/providers" })}
            />
          }
        >
          <span className="block text-foreground">fwai Gateway</span>
          <span className="block truncate">{routing.enabled ? "On" : "Off"}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{detail}</TooltipPopup>
      </Tooltip>
      <Switch
        size="sm"
        checked={routing.enabled}
        disabled={routing.busy || routing.unavailableReason !== null}
        aria-label="Route through fwai Gateway"
        onCheckedChange={(checked) => void routing.setEnabled(Boolean(checked))}
      />
    </div>
  );
}
