import { describe, expect, it } from "vitest";

import {
  getHistorySyncInitialRecoveryActionCopy,
  getHistorySyncInitialRecoveryPhaseLabel,
} from "./ConnectionsSettings";

describe("history sync initial recovery helpers", () => {
  it("formats recovery phase labels", () => {
    expect(getHistorySyncInitialRecoveryPhaseLabel("backup")).toBe("Creating backup");
    expect(getHistorySyncInitialRecoveryPhaseLabel("push-local")).toBe("Pushing local history");
    expect(getHistorySyncInitialRecoveryPhaseLabel("push-merge")).toBe(
      "Pushing merged local history",
    );
    expect(getHistorySyncInitialRecoveryPhaseLabel("import-remote")).toBe(
      "Importing remote history",
    );
    expect(getHistorySyncInitialRecoveryPhaseLabel("write-state")).toBe("Saving sync state");
  });

  it("uses manual retry copy for failed and in-progress recovery metadata", () => {
    expect(
      getHistorySyncInitialRecoveryActionCopy({
        phase: "import-remote",
        startedAt: "2026-05-01T00:00:00.000Z",
      }),
    ).toBe("Start history sync again to continue from the current safe recovery point.");
    expect(
      getHistorySyncInitialRecoveryActionCopy({
        phase: "import-remote",
        startedAt: "2026-05-01T00:00:00.000Z",
        error: "2026-05-01T00:01:00.000Z: import failed",
      }),
    ).toBe("Review the error, then start history sync again when ready.");
  });
});
