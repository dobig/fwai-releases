import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, GaugeIcon } from "lucide-react";

import type { FwaiQuotaProject } from "../../fwaiAccount/session";
import { useFwaiGatewayRouting } from "../../fwaiGateway/useFwaiGatewayRouting";
import {
  formatProjectQuota,
  useFwaiOrganizationQuota,
} from "../../fwaiGateway/useFwaiOrganizationQuota";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Menu,
  MenuItemLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import type { FwaiGatewayThreadRoute } from "./FwaiGatewayThreadRouteTag";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

/** What the thread card needs to know about a thread's fwai Gateway routing. */
export interface ThreadFwaiGateway {
  readonly driver: string;
  /** The provider a Codex thread started on; null before it has started. */
  readonly codexRoute: FwaiGatewayThreadRoute | null;
  readonly projectId: string | null;
}

const FOLLOW_DEFAULT = "__default__";

function UsageText({ project }: { readonly project: FwaiQuotaProject | undefined }) {
  if (project === undefined) return null;
  const text = project.usable ? formatProjectQuota(project) : "No allowance";
  if (text === null) return null;
  return <span className="ms-auto ps-4 text-muted-foreground text-xs tabular-nums">{text}</span>;
}

/**
 * "Cost from <project>": the organization project whose quota this thread uses. Only for
 * organization members while the thread goes through fwai Gateway; applies from the next message.
 */
export function ThreadQuotaPicker({
  environmentId,
  threadId,
  thread,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: ThreadFwaiGateway;
}) {
  const routing = useFwaiGatewayRouting(environmentId);
  const quota = useFwaiOrganizationQuota(routing.enabled && routing.connected);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, "quota project update");

  const routed =
    thread.driver === "claudeAgent"
      ? routing.routesDriver("claudeAgent")
      : thread.driver === "codex"
        ? thread.codexRoute === "gateway" ||
          (thread.codexRoute === null && routing.routesDriver("codex"))
        : false;
  if (!routing.enabled || !routed || quota === null || quota.projects.length === 0) return null;

  const byId = (id: string | null) => quota.projects.find((project) => project.id === id);
  const defaultProject = byId(routing.defaultProjectId) ?? byId(quota.currentProjectId);
  const selected = byId(thread.projectId);
  const shown = selected ?? defaultProject;

  return (
    <ThreadDetailsSection
      headingId="thread-details-quota-heading"
      title="Quota"
      showHeading={false}
    >
      <Menu>
        <MenuTrigger
          disabled={!canOperate}
          render={<ThreadDetailsControl size="sm" variant="ghost" aria-label="Quota project" />}
        >
          <GaugeIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={`min-w-0 truncate ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}>
            Cost from {shown?.name ?? "your default project"}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={`ms-auto ${THREAD_DETAILS_PANEL_CHEVRON_CLASS}`}
          />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-(--anchor-width)">
          <MenuRadioGroup
            value={thread.projectId ?? FOLLOW_DEFAULT}
            onValueChange={(value) =>
              void updateMetadata({
                environmentId,
                input: {
                  threadId,
                  fwaiGatewayProjectId: value === FOLLOW_DEFAULT ? null : String(value),
                },
              })
            }
          >
            <MenuRadioItem value={FOLLOW_DEFAULT}>
              <MenuItemLabel>
                Default{defaultProject ? ` (${defaultProject.name})` : ""}
              </MenuItemLabel>
              <UsageText project={defaultProject} />
            </MenuRadioItem>
            <MenuSeparator />
            {quota.projects.map((project) => (
              <MenuRadioItem key={project.id} value={project.id} disabled={!project.usable}>
                <MenuItemLabel>{project.name}</MenuItemLabel>
                <UsageText project={project} />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </ThreadDetailsSection>
  );
}
