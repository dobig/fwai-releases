import { fwaiSignInAgainNotice } from "@t3tools/client-runtime/fwai-gateway";
import {
  CircleAlertIcon,
  LogInIcon,
  LogOutIcon,
  ServerIcon,
  SmartphoneIcon,
  UserRoundIcon,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";

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
  const signInAgain = useSyncExternalStore(
    fwaiSignInAgainNotice.subscribe,
    fwaiSignInAgainNotice.get,
  );
  if (state.status !== "signedIn") return null;
  const signOut = () => {
    fwaiSignInAgainNotice.clear();
    void getFwaiAccountSession()?.signOut();
  };

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <Menu>
            <MenuTrigger render={<SidebarMenuButton />}>
              <UserRoundIcon />
              <span>{state.user.username}</span>
              {signInAgain ? <CircleAlertIcon className="ml-auto text-warning" /> : null}
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
              {signInAgain ? (
                <>
                  <div className="max-w-64 px-2 py-1 text-xs text-muted-foreground">
                    Sign in again so fwai can recognize this app.
                  </div>
                  <MenuItem onClick={signOut}>
                    <LogInIcon />
                    Sign in again
                  </MenuItem>
                </>
              ) : null}
              <MenuItem onClick={signOut}>
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
