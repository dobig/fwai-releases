import type { FwaiOrganizationQuota } from "../../fwaiAccount/session";
import { formatProjectQuota } from "../../fwaiGateway/useFwaiOrganizationQuota";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const FOLLOW = "__follow__";

/**
 * Picks an organization project whose quota routed requests use. `null` follows `followLabel`
 * (the account's gateway default in settings, the environment default on a thread).
 */
export function QuotaProjectSelect({
  quota,
  value,
  followLabel,
  onChange,
  ariaLabel,
  className,
}: {
  readonly quota: FwaiOrganizationQuota;
  readonly value: string | null;
  readonly followLabel: string;
  readonly onChange: (projectId: string | null) => void;
  readonly ariaLabel: string;
  readonly className?: string;
}) {
  const selected = quota.projects.find((project) => project.id === value);
  return (
    <Select
      value={value ?? FOLLOW}
      onValueChange={(next) => onChange(next === FOLLOW ? null : String(next))}
    >
      <SelectTrigger size="sm" className={className} aria-label={ariaLabel}>
        <SelectValue>{selected?.name ?? followLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value={FOLLOW}>{followLabel}</SelectItem>
        {quota.projects.map((project) => {
          const usage = formatProjectQuota(project);
          return (
            <SelectItem key={project.id} value={project.id} disabled={!project.usable}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{project.name}</span>
                <span className="text-muted-foreground text-xs">
                  {project.usable ? (usage ?? "No usage yet") : "No allowance for you"}
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

export function projectName(quota: FwaiOrganizationQuota, projectId: string | null) {
  return quota.projects.find((project) => project.id === projectId)?.name ?? null;
}
