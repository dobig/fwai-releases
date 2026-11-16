import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button, InlineButton } from "../ui/button";
import { type AccountPageId, AccountPagesDialog } from "./AccountPagesDialog";

export function RemoveT3ConnectEnvironmentDialog({
  environmentLabel,
  onCancel,
  onConfirm,
}: {
  readonly environmentLabel: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const [accountPage, setAccountPage] = useState<AccountPageId | null>(null);
  const [shownLabel, setShownLabel] = useState(environmentLabel);
  if (environmentLabel !== null && environmentLabel !== shownLabel) setShownLabel(environmentLabel);

  return (
    <>
      <AlertDialog
        open={environmentLabel !== null}
        onOpenChange={(open) => {
          if (!open) onCancel();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {shownLabel} from this device?</AlertDialogTitle>
            <AlertDialogDescription>
              This forgets its pairing, credentials, and cached threads here.
            </AlertDialogDescription>
            <AlertDialogDescription>
              It stays on your fwai Connect account and keeps its host space. Deregister it in{" "}
              <InlineButton
                onClick={() => {
                  onCancel();
                  setAccountPage("t3-connect");
                }}
              >
                fwai Connect settings
              </InlineButton>{" "}
              to free it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={onConfirm}>
              Remove from this device
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AccountPagesDialog
        page={accountPage}
        onPageChange={setAccountPage}
        onClose={() => setAccountPage(null)}
      />
    </>
  );
}
