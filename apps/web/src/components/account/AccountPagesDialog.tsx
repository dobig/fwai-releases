import { useState } from "react";

import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { MobileClientsAccountPage } from "./MobileClientsAccountPage";
import { T3ConnectAccountPage } from "./T3ConnectAccountPage";

export type AccountPageId = "mobile-clients" | "t3-connect";

const ACCOUNT_PAGES: ReadonlyArray<{ readonly id: AccountPageId; readonly label: string }> = [
  { id: "mobile-clients", label: "Mobile clients" },
  { id: "t3-connect", label: "fwai Connect" },
];

export function AccountPagesDialog({
  page,
  onPageChange,
  onClose,
}: {
  readonly page: AccountPageId | null;
  readonly onPageChange: (page: AccountPageId) => void;
  readonly onClose: () => void;
}) {
  // Keep the last page rendered while the dialog animates closed.
  const [shownPage, setShownPage] = useState(page);
  if (page !== null && page !== shownPage) setShownPage(page);

  return (
    <Dialog
      open={page !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex gap-1">
            {ACCOUNT_PAGES.map((entry) => (
              <Button
                key={entry.id}
                size="sm"
                variant={entry.id === shownPage ? "secondary" : "ghost"}
                onClick={() => onPageChange(entry.id)}
              >
                {entry.label}
              </Button>
            ))}
          </div>
          {shownPage === "mobile-clients" ? <MobileClientsAccountPage /> : null}
          {shownPage === "t3-connect" ? <T3ConnectAccountPage /> : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
