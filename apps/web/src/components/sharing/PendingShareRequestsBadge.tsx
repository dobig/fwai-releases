import { useAtomValue } from "@effect/atom-react";

import { sharedThreads } from "~/state/sharing";
import { Badge } from "../ui/badge";

/**
 * How many whole-organization shares members are waiting on an org owner to decide; renders
 * nothing for members and when none wait. `overlay` pins it to the corner of an icon button.
 */
export function PendingShareRequestsBadge({ overlay = false }: { readonly overlay?: boolean }) {
  const count = useAtomValue(sharedThreads.pendingOrgShareRequestCountAtom);
  if (count === 0) return null;
  return (
    <span
      className={
        overlay ? "pointer-events-none absolute -top-0.5 -right-0.5 flex" : "ml-auto flex shrink-0"
      }
      aria-label={`${count} organization share request${count === 1 ? "" : "s"} waiting`}
    >
      <Badge size="sm" variant="default">
        {count > 9 ? "9+" : count}
      </Badge>
    </span>
  );
}
