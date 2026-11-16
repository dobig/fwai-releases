import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { UsersIcon } from "lucide-react";

import { useQuietThreadShell } from "~/state/entities";
import { canShareWithOrganizationAtom } from "~/state/sharing";
import { Button } from "../ui/button";
import { openThreadShareDialog } from "./threadShareDialogState";

/**
 * Header status for a thread the owner shared, or an agent proposed sharing; opens the share
 * dialog, where proposals are approved or rejected.
 */
export function ThreadShareIndicator({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(threadRef);
  const shareCount = shell?.shareCount ?? 0;
  const proposed = (shell?.proposedShareCount ?? 0) > 0;
  const canShare = useAtomValue(canShareWithOrganizationAtom(threadRef.environmentId));
  if (shareCount === 0 || !canShare) return null;
  return (
    <Button size="xs" variant="ghost-muted" onClick={() => openThreadShareDialog(threadRef)}>
      <UsersIcon aria-hidden />
      {/* The chat header is the container: a narrow one keeps only the icon. */}
      <span className="@max-md:sr-only">{proposed ? "Share proposed" : "Shared"}</span>
    </Button>
  );
}
