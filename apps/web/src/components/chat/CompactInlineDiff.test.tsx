import type { FileDiffMetadata } from "@pierre/diffs/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildCompactDiffRenderModel, CompactInlineDiff } from "./CompactInlineDiff";

function buildFileDiff(override: Partial<FileDiffMetadata> = {}): FileDiffMetadata {
  return {
    name: "src/app.ts",
    type: "change",
    hunks: [
      {
        collapsedBefore: 12,
        deletionStart: 20,
        deletionCount: 1,
        deletionLines: 1,
        deletionLineIndex: 0,
        additionStart: 20,
        additionCount: 1,
        additionLines: 1,
        additionLineIndex: 0,
        hunkContent: [
          {
            type: "change",
            deletions: 1,
            deletionLineIndex: 0,
            additions: 1,
            additionLineIndex: 0,
          },
        ],
        splitLineStart: 0,
        splitLineCount: 1,
        unifiedLineStart: 0,
        unifiedLineCount: 2,
        noEOFCRDeletions: false,
        noEOFCRAdditions: false,
      },
    ],
    splitLineCount: 1,
    unifiedLineCount: 2,
    isPartial: true,
    deletionLines: ['const label = "Create project";\n'],
    additionLines: ['const label = "Create workspace";\n'],
    ...override,
  };
}

describe("CompactInlineDiff", () => {
  it("builds a compact render model for one-to-one changed lines", () => {
    const model = buildCompactDiffRenderModel(buildFileDiff());

    expect(model).not.toBeNull();
    expect(model?.filePath).toBe("src/app.ts");
    expect(model?.additions).toBe(1);
    expect(model?.deletions).toBe(1);
    expect(model?.rows).toHaveLength(2);
  });

  it("renders removed and added spans in one compact row", () => {
    const model = buildCompactDiffRenderModel(buildFileDiff());
    expect(model).not.toBeNull();

    const markup = renderToStaticMarkup(<CompactInlineDiff model={model!} />);

    expect(markup).toContain("data-compact-inline-diff");
    expect(markup).toContain("Create");
    expect(markup).toContain("project");
    expect(markup).toContain("workspace");
    expect(markup).toContain("line-through");
  });

  it("collapses matching deletion and addition line numbers into one changed line number", () => {
    const model = buildCompactDiffRenderModel(buildFileDiff());
    expect(model).not.toBeNull();

    const markup = renderToStaticMarkup(<CompactInlineDiff model={model!} />);

    expect(markup).toContain("data-collapsed-line-number");
    expect(markup).not.toContain("lucide-chevron-right");
  });

  it("keeps split line numbers when changed line numbers differ", () => {
    const model = buildCompactDiffRenderModel(
      buildFileDiff({
        hunks: [
          {
            ...buildFileDiff().hunks[0]!,
            deletionStart: 20,
            additionStart: 24,
          },
        ],
      }),
    );
    expect(model).not.toBeNull();

    const markup = renderToStaticMarkup(<CompactInlineDiff model={model!} />);

    expect(markup).not.toContain("data-collapsed-line-number");
    expect(markup).toContain("lucide-chevron-right");
  });

  it("keeps replacements at the changed word instead of marking the suffix", () => {
    const model = buildCompactDiffRenderModel(
      buildFileDiff({
        deletionLines: ["The project starts with a quiet idea and turns it into a working tool.\n"],
        additionLines: [
          "The project starts with a quiet idea and turns it into a working instrument.\n",
        ],
      }),
    );
    expect(model).not.toBeNull();

    const changeRow = model!.rows.find((row) => row.kind === "change");

    expect(changeRow?.tokens.map((token) => [token.kind, token.text])).toEqual([
      ["equal", "The project starts with a quiet idea and turns it into a working "],
      ["removed", "tool"],
      ["added", "instrument"],
      ["equal", ".\n"],
    ]);
  });

  it("compacts line-aligned multi-line replacement blocks", () => {
    const model = buildCompactDiffRenderModel(
      buildFileDiff({
        hunks: [
          {
            ...buildFileDiff().hunks[0]!,
            deletionCount: 3,
            deletionLines: 3,
            additionCount: 3,
            additionLines: 3,
            hunkContent: [
              {
                type: "change",
                deletions: 3,
                deletionLineIndex: 0,
                additions: 3,
                additionLineIndex: 0,
              },
            ],
            splitLineCount: 3,
            unifiedLineCount: 6,
          },
        ],
        splitLineCount: 3,
        unifiedLineCount: 6,
        deletionLines: [
          "The project begins with a quiet idea.\n",
          "\n",
          "Performance matters because slow instruments interrupt thought.\n",
        ],
        additionLines: [
          "The project begins with a practical idea.\n",
          "\n",
          "Performance matters because slow instruments interrupt thought and make feedback loops expensive.\n",
        ],
      }),
    );

    expect(model).not.toBeNull();
    expect(model?.deletions).toBe(3);
    expect(model?.additions).toBe(3);
    expect(model?.rows.filter((row) => row.kind === "change")).toHaveLength(2);
  });

  it("declines line-aligned replacement blocks when paired lines are unrelated", () => {
    const model = buildCompactDiffRenderModel(
      buildFileDiff({
        deletionLines: ["const value = alpha;\n"],
        additionLines: ["completely unrelated prose\n"],
      }),
    );

    expect(model).toBeNull();
  });

  it("declines multi-line change blocks so Pierre can render the fallback", () => {
    const model = buildCompactDiffRenderModel(
      buildFileDiff({
        hunks: [
          {
            ...buildFileDiff().hunks[0]!,
            hunkContent: [
              {
                type: "change",
                deletions: 2,
                deletionLineIndex: 0,
                additions: 1,
                additionLineIndex: 0,
              },
            ],
          },
        ],
      }),
    );

    expect(model).toBeNull();
  });
});
