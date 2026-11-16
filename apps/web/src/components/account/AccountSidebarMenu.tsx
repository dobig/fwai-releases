import { LogOutIcon, ServerIcon, SmartphoneIcon, UserRoundIcon } from "lucide-react";
import { useState } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { getFwaiAccountSession } from "../../fwaiAccount/session";
import { useFwaiAccount } from "../../fwaiAccount/useFwaiAccount";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { type AccountPageId, AccountPagesDialog } from "./AccountPagesDialog";

export function AccountSidebarMenu() {
  if (!hasCloudPublicConfig()) return null;
  return <SignedInAccountSidebarMenu />;
}

function SignedInAccountSidebarMenu() {
  const state = useFwaiAccount();
  const [page, setPage] = useState<AccountPageId | null>(null);
  if (state.status !== "signedIn") return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <Menu>
            <MenuTrigger render={<SidebarMenuButton />}>
              <UserRoundIcon />
              <span>{state.user.username}</span>
            </MenuTrigger>
            <MenuPopup align="start" side="top">
              {state.user.email ? (
                <div className="px-2 py-1 text-xs text-muted-foreground">{state.user.email}</div>
              ) : null}
              <MenuItem onClick={() => setPage("mobile-clients")}>
                <SmartphoneIcon />
                Mobile clients
              </MenuItem>
              <MenuItem onClick={() => setPage("t3-connect")}>
                <ServerIcon />
                fwai Connect
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => void getFwaiAccountSession()?.signOut()}>
                <LogOutIcon />
                Sign out
              </MenuItem>
            </MenuPopup>
          </Menu>
        </SidebarMenuItem>
      </SidebarMenu>
      <AccountPagesDialog page={page} onPageChange={setPage} onClose={() => setPage(null)} />
    </>
  );
}
