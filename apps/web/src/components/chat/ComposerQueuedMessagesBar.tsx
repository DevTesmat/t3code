import {
  ChevronRightIcon,
  ImageIcon,
  PaperclipIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export interface ComposerQueuedMessagesBarMessage {
  id: string;
  text: string;
  attachments: { length: number };
  terminalContexts: { length: number };
}

export interface ComposerQueuedMessagesBarProps {
  messages: ReadonlyArray<ComposerQueuedMessagesBarMessage>;
  onDeleteMessage: (messageId: string) => void;
}

const QUEUED_MESSAGE_ROW_HEIGHT_PX = 34;
const QUEUED_MESSAGE_LIST_VERTICAL_PADDING_PX = 12;
export const QUEUED_MESSAGE_LIST_MAX_HEIGHT_PX =
  QUEUED_MESSAGE_ROW_HEIGHT_PX * 4 + QUEUED_MESSAGE_LIST_VERTICAL_PADDING_PX;

function formatCountLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export const ComposerQueuedMessagesBar = memo(function ComposerQueuedMessagesBar({
  messages,
  onDeleteMessage,
}: ComposerQueuedMessagesBarProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (messages.length === 0) {
      setExpanded(false);
    }
  }, [messages.length]);

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="mb-1.5 overflow-hidden rounded-md border border-border/70 bg-card/45">
      <div className="flex min-h-8 items-center gap-1.5 px-2">
        <button
          type="button"
          data-scroll-anchor-ignore
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
              expanded && "rotate-90",
            )}
          />
          <span className="truncate text-[11px] font-medium text-muted-foreground/85 group-hover:text-foreground/90">
            Queued messages ({messages.length})
          </span>
        </button>
      </div>
      {expanded && (
        <div className="border-border/55 border-t">
          <div
            className="overflow-y-auto px-1.5 py-1.5"
            data-composer-queued-messages-scroll="true"
            style={{ maxHeight: QUEUED_MESSAGE_LIST_MAX_HEIGHT_PX }}
          >
            <div className="flex flex-col gap-1">
              {messages.map((message) => {
                const trimmedText = message.text.trim();
                const hasAttachments = message.attachments.length > 0;
                const hasTerminalContexts = message.terminalContexts.length > 0;
                const preview =
                  trimmedText.length > 0
                    ? trimmedText
                    : hasAttachments
                      ? "Image-only queued message"
                      : "Empty queued message";

                return (
                  <div
                    key={message.id}
                    className="flex min-h-[34px] items-center gap-2 rounded-sm px-1.5 text-[11px] hover:bg-muted/35"
                    data-composer-queued-message-row="true"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground/90">{preview}</div>
                    </div>
                    {hasAttachments ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {trimmedText.length === 0 ? (
                          <ImageIcon aria-hidden="true" className="size-3" />
                        ) : (
                          <PaperclipIcon aria-hidden="true" className="size-3" />
                        )}
                        {formatCountLabel(message.attachments.length, "image")}
                      </span>
                    ) : null}
                    {hasTerminalContexts ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        <SquareTerminalIcon aria-hidden="true" className="size-3" />
                        {formatCountLabel(message.terminalContexts.length, "terminal")}
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete queued message: ${preview}`}
                      onClick={() => onDeleteMessage(message.id)}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
