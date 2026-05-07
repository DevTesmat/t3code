import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { AppTopbarBrand } from "./AppTopbarBrand";
import { HistorySyncTopbarStatus } from "./HistorySyncTopbarStatus";

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background pt-[52px] wco:pt-[env(titlebar-area-height)]">
        <header
          className={cn(
            "app-topbar-main fixed top-0 right-0 left-0 z-30 border-b border-border bg-background",
            isElectron
              ? "drag-region flex h-[52px] items-center px-3 pl-[104px] sm:px-5 sm:pl-[104px] wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)] desktop-fullscreen:pl-3 desktop-fullscreen:sm:pl-5 desktop-fullscreen:wco:pl-3 desktop-fullscreen:wco:sm:pl-5"
              : "px-3 py-2 sm:px-5 sm:py-3",
          )}
        >
          <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3",
                isElectron &&
                  "wco:pr-[calc(100vw-env(titlebar-area-x)-env(titlebar-area-width)+1em)]",
              )}
            >
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <AppTopbarBrand />
              <div className="h-4 w-px shrink-0 bg-border" />
              <h2
                className="min-w-0 shrink truncate text-sm font-medium text-foreground"
                title="No active thread"
              >
                No active thread
              </h2>
            </div>
            <div className="ms-auto flex shrink-0 items-center justify-end gap-2">
              <HistorySyncTopbarStatus />
            </div>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-lg rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-xl">Pick a thread to continue</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Select an existing thread or create a new one to get started.
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
