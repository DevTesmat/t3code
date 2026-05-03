import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { syncDocumentWindowControlsOverlayClass } from "./windowControlsOverlay";

class ClassListStub {
  readonly values = new Set<string>();

  toggle(className: string, force?: boolean): boolean {
    const shouldAdd = force ?? !this.values.has(className);
    if (shouldAdd) {
      this.values.add(className);
    } else {
      this.values.delete(className);
    }
    return shouldAdd;
  }

  contains(className: string): boolean {
    return this.values.has(className);
  }
}

class EventTargetStub {
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class OverlayStub extends EventTargetStub {
  visible: boolean;

  constructor(visible: boolean) {
    super();
    this.visible = visible;
  }
}

function installDomStubs(input: {
  readonly overlay?: OverlayStub;
  readonly visibilityState?: DocumentVisibilityState;
}) {
  const classList = new ClassListStub();
  const documentTarget = new EventTargetStub();
  const windowTarget = new EventTargetStub();
  const documentStub = {
    documentElement: { classList },
    visibilityState: input.visibilityState ?? "visible",
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
  };
  const windowStub = {
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
  };
  const navigatorStub = input.overlay === undefined ? {} : { windowControlsOverlay: input.overlay };

  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("navigator", navigatorStub);

  return { classList, documentStub, documentTarget, windowTarget };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("syncDocumentWindowControlsOverlayClass", () => {
  it("toggles the wco class immediately from overlay visibility", () => {
    const overlay = new OverlayStub(true);
    const { classList } = installDomStubs({ overlay });

    const cleanup = syncDocumentWindowControlsOverlayClass();

    assert.isTrue(classList.contains("wco"));
    cleanup();
  });

  it("rechecks overlay visibility on deferred callbacks", () => {
    vi.useFakeTimers();
    const overlay = new OverlayStub(false);
    const { classList } = installDomStubs({ overlay });
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const cleanup = syncDocumentWindowControlsOverlayClass();
    assert.isFalse(classList.contains("wco"));

    overlay.visible = true;
    animationFrameCallbacks[0]?.(0);
    assert.isTrue(classList.contains("wco"));

    overlay.visible = false;
    vi.advanceTimersByTime(50);
    assert.isFalse(classList.contains("wco"));

    cleanup();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it("updates on geometrychange and removes listeners during cleanup", () => {
    const overlay = new OverlayStub(false);
    const { classList, documentTarget, windowTarget } = installDomStubs({ overlay });

    const cleanup = syncDocumentWindowControlsOverlayClass();
    assert.strictEqual(overlay.listenerCount("geometrychange"), 1);
    assert.strictEqual(documentTarget.listenerCount("visibilitychange"), 1);
    assert.strictEqual(windowTarget.listenerCount("focus"), 1);

    overlay.visible = true;
    overlay.dispatch("geometrychange");
    assert.isTrue(classList.contains("wco"));

    cleanup();
    assert.strictEqual(overlay.listenerCount("geometrychange"), 0);
    assert.strictEqual(documentTarget.listenerCount("visibilitychange"), 0);
    assert.strictEqual(windowTarget.listenerCount("focus"), 0);
  });

  it("rechecks when the document becomes visible or the window receives focus", () => {
    const overlay = new OverlayStub(false);
    const { classList, documentStub, documentTarget, windowTarget } = installDomStubs({
      overlay,
      visibilityState: "hidden",
    });

    const cleanup = syncDocumentWindowControlsOverlayClass();
    overlay.visible = true;
    Object.defineProperty(documentStub, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    documentTarget.dispatch("visibilitychange");
    assert.isTrue(classList.contains("wco"));

    overlay.visible = false;
    windowTarget.dispatch("focus");
    assert.isFalse(classList.contains("wco"));

    cleanup();
  });
});
