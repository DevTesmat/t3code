import { memo, useCallback, useState } from "react";
import { ClipboardPasteIcon, PaperclipIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

function trimTrailingBlankSpace(value: string): string {
  return value.replace(/[ \t\r\n]+$/u, "");
}

export const ComposerAttachMenu = memo(function ComposerAttachMenu(props: {
  disabled: boolean;
  importDisabledReason: string | null;
  onImportPlanMarkdown: (planMarkdown: string) => Promise<void>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const resetDialog = useCallback(() => {
    setMarkdown("");
    setValidationMessage(null);
    setImporting(false);
  }, []);

  const handleImport = useCallback(async () => {
    const planMarkdown = trimTrailingBlankSpace(markdown);
    if (planMarkdown.trim().length === 0) {
      setValidationMessage("Paste a non-empty markdown plan.");
      return;
    }

    setImporting(true);
    try {
      await props.onImportPlanMarkdown(planMarkdown);
      setDialogOpen(false);
      resetDialog();
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Failed to import plan.");
      setImporting(false);
    }
  }, [markdown, props, resetDialog]);

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              className="shrink-0 text-muted-foreground/70 hover:text-foreground/80"
              disabled={props.disabled}
              aria-label="Attach"
            />
          }
        >
          <PaperclipIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" side="top">
          <MenuItem
            disabled={props.importDisabledReason !== null}
            onClick={() => {
              if (props.importDisabledReason !== null) return;
              setDialogOpen(true);
            }}
          >
            <ClipboardPasteIcon className="size-4 shrink-0" />
            {props.importDisabledReason ?? "Paste plan MD"}
          </MenuItem>
        </MenuPopup>
      </Menu>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) resetDialog();
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Paste plan MD</DialogTitle>
            <DialogDescription>
              Import markdown as the current thread's proposed plan.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <textarea
              value={markdown}
              onChange={(event) => {
                setMarkdown(event.target.value);
                if (validationMessage) setValidationMessage(null);
              }}
              className="min-h-48 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              placeholder="# Plan&#10;&#10;- Step one"
              aria-label="Plan markdown"
              autoFocus
            />
            {validationMessage ? (
              <p className="text-destructive text-sm">{validationMessage}</p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={importing}>
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={importing}>
              Import
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
