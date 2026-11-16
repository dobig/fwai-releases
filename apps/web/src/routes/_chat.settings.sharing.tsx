import { createFileRoute } from "@tanstack/react-router";

import { SharingSettingsPanel } from "../components/settings/SharingSettingsPanel";

export const Route = createFileRoute("/_chat/settings/sharing")({
  component: SharingSettingsPanel,
});
