const WCO_CLASS_NAME = "wco";
const DESKTOP_FULLSCREEN_CLASS_NAME = "desktop-fullscreen";

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ?? null;
}

export function syncDocumentWindowControlsOverlayClass(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const update = () => {
    const overlay = getWindowControlsOverlay();
    document.documentElement.classList.toggle(WCO_CLASS_NAME, overlay !== null && overlay.visible);
  };

  const animationFrameIds: number[] = [];
  const timeoutIds: ReturnType<typeof setTimeout>[] = [];

  const scheduleAnimationFrameUpdate = () => {
    if (typeof requestAnimationFrame !== "function") {
      return;
    }

    animationFrameIds.push(requestAnimationFrame(update));
  };

  const scheduleTimeoutUpdate = (delayMs: number) => {
    timeoutIds.push(setTimeout(update, delayMs));
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      update();
      scheduleAnimationFrameUpdate();
    }
  };

  const onWindowFocus = () => {
    update();
    scheduleAnimationFrameUpdate();
  };

  update();
  scheduleAnimationFrameUpdate();
  scheduleTimeoutUpdate(50);

  document.addEventListener("visibilitychange", onVisibilityChange);
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onWindowFocus);
  }

  const overlay = getWindowControlsOverlay();
  if (!overlay) {
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onWindowFocus);
      }
      if (typeof cancelAnimationFrame === "function") {
        for (const animationFrameId of animationFrameIds) {
          cancelAnimationFrame(animationFrameId);
        }
      }
      for (const timeoutId of timeoutIds) {
        clearTimeout(timeoutId);
      }
    };
  }

  overlay.addEventListener("geometrychange", update);
  return () => {
    overlay.removeEventListener("geometrychange", update);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onWindowFocus);
    }
    if (typeof cancelAnimationFrame === "function") {
      for (const animationFrameId of animationFrameIds) {
        cancelAnimationFrame(animationFrameId);
      }
    }
    for (const timeoutId of timeoutIds) {
      clearTimeout(timeoutId);
    }
  };
}

export function syncDocumentDesktopWindowStateClass(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }

  const bridge = window.desktopBridge;
  if (!bridge?.getWindowState || !bridge.onWindowState) {
    return () => {};
  }

  const update = (state: { isFullScreen: boolean }) => {
    document.documentElement.classList.toggle(DESKTOP_FULLSCREEN_CLASS_NAME, state.isFullScreen);
  };

  void bridge
    .getWindowState()
    .then(update)
    .catch(() => undefined);
  return bridge.onWindowState(update);
}
