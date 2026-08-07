#!/usr/bin/env node
/**
 * check — Spooner M3: re-run the audit, compare against the baseline and
 * the .ai-native.yml manifest, report drift with fixed suggestions.
 *
 * The loop (docs/02 §3): audit = check-up, transform = surgery, check =
 * re-check. Readiness decays (AGENTS.md goes stale, gates get deleted);
 * check makes detection repeatable with records.
 *
 * The baseline ledger (.ai-native/baseline.json) holds the latest run —
 * written on every check (a ledger, so the date is allowed); the report
 * itself is deterministic for a given repo state + baseline.
 *
 * Zero dependencies (Node builtins only); runs natively via Node's
 * type stripping — no build step:
 *   node skills/spooner/scripts/check.ts [--root <path>] [--format json|markdown]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDirectEntry } from "./entry.ts";
import { runAudit } from "./audit.ts";
import { checkConsistency } from "./transform.ts";
import { outdatedTemplates } from "./sync.ts";

const BASELINE_DIR = ".ai-native";
const BASELINE_FILE = "baseline.json";
const SCHEMA_VERSION = 3;

interface Baseline {
  schemaVersion: number;
  date: string;
  score: { total: number; max: number; byCategory: Record<string, { score: number; max: number }> };
  gaps: string[];
}

interface BaselineRead {
  baseline: Baseline | null;
  /** Older-scoring-model baseline found (v1 20-point / v2 10-point) — scores are not comparable across models. */
  oldModel: boolean;
}

interface CheckReport {
  schemaVersion: number;
  root: string;
  score: { total: number; max: number; byCategory: Record<string, { score: number; max: number }> };
  maturity: string;
  gaps: string[];
  baseline: { present: boolean; date: string | null; total: number | null; delta: number | null };
  drift: { consistent: boolean; missing: string[] } | null;
  suggestions: string[];
}

function baselinePath(root: string): string {
  return join(root, BASELINE_DIR, BASELINE_FILE);
}

function readBaseline(root: string): BaselineRead {
  let raw: string | null = null;
  try {
    raw = readFileSync(baselinePath(root), "utf8");
  } catch {
    return { baseline: null, oldModel: false };
  }
  try {
    const parsed = JSON.parse(raw) as Baseline;
    if (parsed.schemaVersion < SCHEMA_VERSION) return { baseline: null, oldModel: true };
    if (
      parsed.schemaVersion !== SCHEMA_VERSION ||
      typeof parsed.score?.total !== "number" ||
      !Array.isArray(parsed.gaps)
    ) {
      return { baseline: null, oldModel: false };
    }
    return { baseline: parsed, oldModel: false };
  } catch {
    return { baseline: null, oldModel: false };
  }
}

function writeBaseline(root: string, baseline: Baseline): void {
  mkdirSync(join(root, BASELINE_DIR), { recursive: true });
  writeFileSync(baselinePath(root), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Which transform stage restores a given manifest file (fixed mapping). */
function stageHint(missing: string[]): number {
  if (missing.some((f) => f.startsWith("docs/sdd") || f.endsWith("sdd.yml"))) return 4;
  if (missing.some((f) => f === "AGENTS.md" || f === "CLAUDE.md")) return 3;
  return 2;
}

export function run(root: string): CheckReport {
  const audit = runAudit(root);
  const { baseline: prev, oldModel } = readBaseline(root);
  const drift = checkConsistency(root);
  const suggestions: string[] = [];

  let baseline: CheckReport["baseline"];
  if (!prev) {
    // first run (or an older-model baseline): record the baseline, report the note
    writeBaseline(root, { schemaVersion: SCHEMA_VERSION, date: today(), score: audit.score, gaps: audit.gaps });
    baseline = { present: false, date: null, total: null, delta: null };
    suggestions.push(
      oldModel
        ? "Baseline from an older scoring model (v1/v2) re-baselined — scores are not comparable across models."
        : "First check — baseline recorded. Re-run later to see readiness drift.",
    );
  } else {
    const delta = audit.score.total - prev.score.total;
    writeBaseline(root, { schemaVersion: SCHEMA_VERSION, date: today(), score: audit.score, gaps: audit.gaps });
    baseline = { present: true, date: prev.date, total: prev.score.total, delta };
    if (delta < 0)
      suggestions.push(
        `Readiness dropped ${-delta} point(s) since ${prev.date} — inspect the gap list (score → fix loop).`,
      );
    else if (delta > 0) suggestions.push(`Readiness improved +${delta} point(s) since ${prev.date}.`);
    else
      suggestions.push(`Readiness unchanged since ${prev.date} (${audit.score.total.toFixed(1)}/${audit.score.max}).`);
  }

  if (!drift) {
    suggestions.push("No .ai-native.yml manifest — run transform stage 2 to install the manifest, then re-check.");
  } else if (!drift.consistent) {
    suggestions.push(
      `Drift: ${drift.missing.length} manifest file(s) missing (${drift.missing.join(", ")}) — re-run transform stage ${stageHint(drift.missing)} to restore them.`,
    );
  }

  const outdated = outdatedTemplates(root);
  if (outdated.length > 0) {
    suggestions.push(
      `Templates outdated: ${outdated.length} file(s) (${outdated.map((f) => f.file).join(", ")}) — run sync to apply the current templates.`,
    );
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    root,
    score: audit.score,
    maturity: audit.maturity,
    gaps: audit.gaps,
    baseline,
    drift,
    suggestions,
  };
}

// --- rendering -----------------------------------------------------------------

function renderMarkdown(r: CheckReport): string {
  const lines: string[] = ["# Check Report", ""];
  lines.push(`- Score: **${r.score.total.toFixed(1)}/${r.score.max}** · Maturity: ${r.maturity} · Root: ${r.root}`, "");
  if (r.baseline.present) {
    const d = r.baseline.delta ?? 0;
    lines.push(
      `- Baseline (${r.baseline.date}): ${r.baseline.total}/${r.score.max} · delta: ${d > 0 ? "+" : ""}${d}`,
      "",
    );
  } else {
    lines.push("- Baseline: none (first run)", "");
  }
  if (r.drift) {
    lines.push(r.drift.consistent ? "- Manifest drift: none" : `- Manifest drift: ${r.drift.missing.join(", ")}`, "");
  } else {
    lines.push("- Manifest: missing (run transform stage 2)", "");
  }
  if (r.gaps.length > 0) lines.push(`- Gaps: ${r.gaps.join(", ")}`, "");
  lines.push("## Suggestions", "");
  for (const s of r.suggestions) lines.push(`- ${s}`);
  lines.push("");
  return lines.join("\n");
}

// --- CLI ------------------------------------------------------------------------

function parseArgs(argv: string[]): { root: string; format: "json" | "markdown" } {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const format = valueOf("--format") === "markdown" ? "markdown" : "json";
  return { root: valueOf("--root") ?? process.cwd(), format };
}

function assertNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok =
    major > 24 || (major === 24 && minor >= 12) || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  if (!ok) {
    console.error(
      `check: Node.js >= 22.18 required (native type stripping); found ${process.versions.node}.\n` +
        "Upgrade Node, e.g. via your version manager (nvm install --lts).",
    );
    process.exit(1);
  }
}

// CLI entry: runs only when executed directly (importing must not trigger side effects)
if (isDirectEntry(import.meta.url)) {
  assertNodeVersion();
  try {
    const { root, format } = parseArgs(process.argv.slice(2));
    const report = run(root);
    process.stdout.write(format === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    console.error(`check: failed to scan ${(err as Error).message}`);
    process.exit(1);
  }
}
