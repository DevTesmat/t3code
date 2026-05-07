import { gzipSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const distDir = join(import.meta.dir, "..", "dist");
const indexPath = join(distDir, "index.html");

const maxInitialGzipBytes = 1_100_000;
const maxEntryJsGzipBytes = 1_050_000;

type AssetBudget = {
  label: string;
  maxBytes: number;
  actualBytes: number;
};

function formatKb(bytes: number): string {
  return `${(bytes / 1_000).toFixed(2)} kB`;
}

function gzipSize(path: string): number {
  return gzipSync(readFileSync(path)).byteLength;
}

function resolveDistAsset(pathFromHtml: string): string {
  const normalizedPath = pathFromHtml.startsWith("/") ? pathFromHtml.slice(1) : pathFromHtml;

  return join(distDir, normalizedPath);
}

function isLocalAsset(pathFromHtml: string): boolean {
  return !/^(?:[a-z]+:)?\/\//i.test(pathFromHtml);
}

function extractAttr(tag: string, attr: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${attr}=["']([^"']+)["']`));

  return match?.[1];
}

function findModuleScriptPaths(indexHtml: string): string[] {
  const scripts = indexHtml.match(/<script\b[^>]*>/g) ?? [];

  return scripts
    .filter((tag) => extractAttr(tag, "type") === "module")
    .map((tag) => extractAttr(tag, "src"))
    .filter((src): src is string => src !== undefined && isLocalAsset(src))
    .map(resolveDistAsset);
}

function findInitialAssetPaths(indexHtml: string): string[] {
  const assetPaths = new Set<string>([indexPath]);
  const stylesheets = indexHtml.match(/<link\b[^>]*>/g) ?? [];

  for (const path of findModuleScriptPaths(indexHtml)) {
    assetPaths.add(path);
  }

  for (const tag of stylesheets) {
    if (extractAttr(tag, "rel") === "stylesheet") {
      const href = extractAttr(tag, "href");

      if (href && isLocalAsset(href)) {
        assetPaths.add(resolveDistAsset(href));
      }
    }
  }

  return [...assetPaths];
}

function findEntryJsAsset(indexHtml: string): string | undefined {
  const scripts = findModuleScriptPaths(indexHtml);
  return scripts.find((path) => basename(path).startsWith("index-")) ?? scripts[0];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!existsSync(indexPath)) {
  fail(
    [
      "Bundle budget check could not find apps/web/dist/index.html.",
      "Run the Vite build before this check so it can measure emitted assets.",
    ].join("\n"),
  );
}

const indexHtml = readFileSync(indexPath, "utf8");
const initialAssetPaths = findInitialAssetPaths(indexHtml);
const missingAssets = initialAssetPaths.filter((path) => !existsSync(path));

if (missingAssets.length > 0) {
  fail(
    [
      "Bundle budget check found missing initial assets referenced by index.html:",
      ...missingAssets.map((path) => `  - ${path}`),
    ].join("\n"),
  );
}

const entryJsPath = findEntryJsAsset(indexHtml);

if (!entryJsPath || !existsSync(entryJsPath)) {
  fail("Bundle budget check could not find the initial JavaScript entry asset.");
}

const budgets: AssetBudget[] = [
  {
    label: "initial payload gzip",
    maxBytes: maxInitialGzipBytes,
    actualBytes: initialAssetPaths.reduce((total, path) => total + gzipSize(path), 0),
  },
  {
    label: `entry JavaScript gzip (${basename(entryJsPath)})`,
    maxBytes: maxEntryJsGzipBytes,
    actualBytes: gzipSize(entryJsPath),
  },
];

const failures = budgets.filter((budget) => budget.actualBytes > budget.maxBytes);

for (const budget of budgets) {
  const status = budget.actualBytes > budget.maxBytes ? "over" : "ok";
  console.log(
    `Bundle budget ${status}: ${budget.label} ${formatKb(budget.actualBytes)} / ${formatKb(budget.maxBytes)}`,
  );
}

if (failures.length > 0) {
  fail(
    [
      "",
      "Bundle size budget exceeded.",
      "These ceilings are intentionally close to the current web payload so new large dependencies, static imports, or code-splitting regressions are caught during build.",
      "If growth is intentional, update the budget in apps/web/scripts/check-bundle-budget.ts with the reason in the review.",
      ...failures.map(
        (budget) =>
          `  - ${budget.label}: ${formatKb(budget.actualBytes)} exceeds ${formatKb(budget.maxBytes)}`,
      ),
    ].join("\n"),
  );
}

const measuredAssets = initialAssetPaths
  .map((path) => `  - ${path.replace(`${dirname(distDir)}/`, "")}: ${formatKb(gzipSize(path))}`)
  .join("\n");

console.log(`Measured initial assets:\n${measuredAssets}`);
