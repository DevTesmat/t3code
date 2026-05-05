import { RotateCcwIcon } from "lucide-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { AppTopbarBrand } from "../components/AppTopbarBrand";
import { HistorySyncTopbarStatus } from "../components/HistorySyncTopbarStatus";
import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { isElectron } from "../env";

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="size-3.5" />
      Restore defaults
    </Button>
  );
}

function SettingsContentLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const showRestoreDefaults = location.pathname === "/settings/general";
  const handleRestored = () => setRestoreSignal((value) => value + 1);
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background pt-[52px] text-foreground wco:pt-[env(titlebar-area-height)]">
        {!isElectron && (
          <header className="app-topbar-main fixed top-0 right-0 left-0 z-30 border-b border-border bg-background px-3 py-2 sm:px-5">
            <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <AppTopbarBrand />
              <div className="h-4 w-px shrink-0 bg-border" />
              <span className="text-sm font-medium text-foreground">Settings</span>
              <div className="ms-auto flex items-center gap-2">
                {showRestoreDefaults ? <RestoreDefaultsButton onRestored={handleRestored} /> : null}
                <HistorySyncTopbarStatus />
              </div>
            </div>
          </header>
        )}

        {isElectron && (
          <div className="app-topbar-main drag-region fixed top-0 right-0 left-0 z-30 flex h-[52px] shrink-0 items-center border-b border-border bg-background px-5 pl-[104px] wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)] wco:pr-[calc(100vw-env(titlebar-area-x)-env(titlebar-area-width)+1em)] desktop-fullscreen:pl-5 desktop-fullscreen:wco:pl-5">
            <AppTopbarBrand />
            <div className="mx-2 h-4 w-px shrink-0 bg-border" />
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
            <div className="ms-auto flex items-center gap-2">
              {showRestoreDefaults ? <RestoreDefaultsButton onRestored={handleRestored} /> : null}
              <HistorySyncTopbarStatus />
            </div>
          </div>
        )}

        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
