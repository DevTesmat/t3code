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
