import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  buildCodexAppServerArgs,
  codexAppServerCommandLabel,
  buildCodexInitializeParams,
} from "./CodexProvider.ts";

describe("CodexProvider app-server startup", () => {
  it("enables Codex file-change patch streaming at process startup", () => {
    assert.deepStrictEqual(buildCodexAppServerArgs(), [
      "app-server",
      "--enable",
      "apply_patch_streaming_events",
    ]);
  });

  it("keeps experimental app-server protocol enabled during initialize", () => {
    assert.deepStrictEqual(buildCodexInitializeParams().capabilities, {
      experimentalApi: true,
    });
  });

  it("reports the same app-server command used for process startup", () => {
    assert.equal(
      codexAppServerCommandLabel("/opt/homebrew/bin/codex"),
      "/opt/homebrew/bin/codex app-server --enable apply_patch_streaming_events",
    );
  });
});
