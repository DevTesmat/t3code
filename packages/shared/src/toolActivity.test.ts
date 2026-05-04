import { describe, expect, it } from "vitest";

import { classifyToolActivityGroup, deriveToolActivityPresentation } from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });
});

describe("classifyToolActivityGroup", () => {
  it("classifies read-only codebase search and inspection commands as exploration", () => {
    for (const command of [
      "rg query apps/web",
      "grep -R query src",
      "find src -name '*.ts'",
      "fd session apps/web",
      "ls apps/web/src",
      "tree apps/web/src/components",
      "pwd",
      "cat package.json",
      "sed -n '1,120p' apps/web/src/session-logic.ts",
      "awk '{ print $1 }' package.json",
      "head -20 README.md",
      "tail -20 README.md",
      "git diff -- apps/web/src/session-logic.ts",
      "git show HEAD:package.json",
      "git status --short",
      "git log --oneline -5",
      "git grep session",
      "git ls-files apps/web",
      "pwd && rg --files | head -20",
      "rg test apps/web",
      `/bin/zsh -lc "rg -n \\"\\\\[WS_METHODS|\\\\[ORCHESTRATION_WS_METHODS|open\\\\.\\" apps/server/src/ws.ts"`,
      `bash -lc "sed -n '1,120p' apps/web/src/session-logic.ts"`,
    ]) {
      expect(classifyToolActivityGroup({ itemType: "command_execution", command })).toBe(
        "exploration",
      );
    }
  });

  it("does not classify mutating command forms as exploration", () => {
    for (const command of [
      "sed -i '' 's/a/b/' app.ts",
      "git checkout -- app.ts",
      "git reset --hard",
      "git clean -fd",
      "git apply patch.diff",
      "find src -name '*.tmp' -delete",
      "rg query > results.txt",
      "cat package.json && rm package.json",
      `/bin/zsh -lc "rg query > results.txt"`,
      `/bin/zsh -lc "cat package.json && rm package.json"`,
    ]) {
      expect(classifyToolActivityGroup({ itemType: "command_execution", command })).toBe("other");
    }
  });

  it("classifies validation commands separately from exploration", () => {
    for (const command of [
      "bun run test",
      "bun lint",
      "bun typecheck",
      "bun run build",
      "pnpm test",
      "npm run test",
      "vitest run",
      "pytest tests",
      "go test ./...",
      "cargo test",
      `/bin/zsh -lc "bun typecheck"`,
    ]) {
      expect(classifyToolActivityGroup({ itemType: "command_execution", command })).toBe(
        "validation",
      );
    }
  });

  it("treats file reads and file-change tools as separate activity classes", () => {
    expect(
      classifyToolActivityGroup({
        itemType: "dynamic_tool_call",
        label: "Read file",
        requestKind: "file-read",
      }),
    ).toBe("exploration");
    expect(
      classifyToolActivityGroup({
        itemType: "file_change",
        label: "File change",
        changedFiles: ["src/app.ts"],
      }),
    ).toBe("other");
  });
});
