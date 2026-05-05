import { describe, expect, it } from "vitest";

import {
  getHistorySyncTopbarProgressPercent,
  getHistorySyncTopbarStatusSummary,
  shouldShowHistorySyncTopbarStatus,
} from "./HistorySyncTopbarStatus";

describe("HistorySyncTopbarStatus logic", () => {
  it("hides unconfigured disabled sync", () => {
    expect(shouldShowHistorySyncTopbarStatus({ state: "disabled", configured: false })).toBe(false);
  });

  it("shows retrying state with retry copy", () => {
    const summary = getHistorySyncTopbarStatusSummary({
      state: "retrying",
      configured: true,
      message: "connect ETIMEDOUT",
      startedAt: "2026-05-05T18:00:00.000Z",
      lastSyncedAt: "2026-05-05T17:47:06.073Z",
      firstFailedAt: "2026-05-05T18:01:00.000Z",
      nextRetryAt: "2026-05-05T18:01:10.000Z",
      attempt: 2,
      maxAttempts: 5,
      recentFailures: [
        {
          failedAt: "2026-05-05T18:01:00.000Z",
          message: "connect ETIMEDOUT",
          attempt: 1,
        },
      ],
    });

    expect(summary.label).toBe("History sync retrying");
    expect(summary.detail).toBe("Retry 2/5 scheduled");
    expect(summary.tone).toBe("warning");
  });

  it("calculates syncing progress percentage", () => {
    expect(
      getHistorySyncTopbarProgressPercent({
        state: "syncing",
        configured: true,
        startedAt: "2026-05-05T18:00:00.000Z",
        lastSyncedAt: null,
        progress: {
          phase: "projecting",
          label: "Projecting threads",
          current: 25,
          total: 100,
        },
      }),
    ).toBe(25);
  });
});
