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

  const overlay = getWindowControlsOverlay();
  const update = () => {
    document.documentElement.classList.toggle(WCO_CLASS_NAME, overlay !== null && overlay.visible);
  };

  update();
  if (!overlay) {
    return () => {};
  }

  overlay.addEventListener("geometrychange", update);
  return () => {
    overlay.removeEventListener("geometrychange", update);
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
