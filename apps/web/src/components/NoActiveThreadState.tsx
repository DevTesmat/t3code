import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { AppTopbarBrand } from "./AppTopbarBrand";

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center pl-[104px] wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+env(titlebar-area-width)+1em)] desktop-fullscreen:pl-3 desktop-fullscreen:sm:pl-5 desktop-fullscreen:wco:pl-3 desktop-fullscreen:wco:sm:pl-5"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <div className="flex min-w-0 items-center gap-2 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              <AppTopbarBrand />
              <div className="h-4 w-px shrink-0 bg-border" />
              <span className="truncate text-xs text-muted-foreground/50">No active thread</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
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
