import { isThreadInviteToken } from "@t3tools/shared/threadInvites";
import { createFileRoute } from "@tanstack/react-router";

import { ThreadInvitePage } from "../components/sharing/ThreadInvitePage";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";

function ThreadInviteRoute() {
  const { token } = Route.useParams();
  if (!isThreadInviteToken(token)) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>This link no longer works</EmptyTitle>
            <EmptyDescription>Ask the person who sent it for a new one.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }
  return <ThreadInvitePage key={token} token={token} />;
}

export const Route = createFileRoute("/_chat/invite/$token")({
  component: ThreadInviteRoute,
});
