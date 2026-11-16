import type { ScopedThreadRef } from "@t3tools/contracts";
import { UsersIcon } from "lucide-react";
import { create } from "zustand";

import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useIsTeamEdition } from "./colleagues";

/** The Team panel's width that fits its longest name; the panel opens at it until resized. */
export const useTeamPanelWidthStore = create<{
  readonly width: number | null;
  readonly setWidth: (width: number) => void;
}>((set) => ({ width: null, setWidth: (width) => set({ width }) }));

export function toggleTeamPanel(threadRef: ScopedThreadRef): void {
  useRightPanelStore.getState().toggle(threadRef, "team");
}

/** The header's Team panel toggle, shown only in the team edition. */
export function TeamPanelToggle({
  threadRef,
  shortcutLabel,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly shortcutLabel: string | null;
}) {
  const team = useIsTeamEdition();
  const open = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, threadRef) === "team",
  );
  if (!team) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="mr-1 flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={open}
          onPressedChange={() => toggleTeamPanel(threadRef)}
          aria-label="Toggle team panel"
          variant="ghost"
          size="sm"
        >
          <UsersIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">Team{shortcutLabel ? ` (${shortcutLabel})` : ""}</TooltipPopup>
    </Tooltip>
  );
}
