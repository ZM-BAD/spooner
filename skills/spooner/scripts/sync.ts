#!/usr/bin/env node
/**
 * sync — Spooner M4: compare installed template files (recorded in
 * .ai-native.yml) against the current skill templates and re-sync them.
 *
 * The loop: transform installs template files and records
 * them in the manifest; when the tool advances (TOOL_VERSION bump with
 * changed templates), installed files go stale — pre-commit rev pins, actions
 * versions, gate configs. sync = versioned re-sync: byte-compare installed vs
 * current template, decide per-file status (up-to-date / outdated / modified /
 * missing / generated), and in apply mode (default) replace outdated + restore
 * missing. `modified` (same-version byte diff) is never touched; `outdated`
 * (older recorded version + byte diff) aligns to the current template by
 * design — if a user edited an OLD-version install, those edits are replaced
 * too (spec 0004 risk register). Dry-run first; every apply reports the git
 * rollback command. check detects → sync applies.
 *
 * Naming (decision #12): "sync" not "upgrade" — transform = AI-ification of
 * the repo; the tool's own upgrade = replacing the skill package
 * (distribution); sync = re-syncing installed artifacts to the
 * current templates (uv sync semantics: reconcile installed → declared).
 *
 * Zero dependencies (Node builtins only); runs natively via Node's
 * type stripping — no build step:
 *   node skills/spooner/scripts/sync.ts [--root <path>] [--dry-run] [--format json|markdown]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDirectEntry } from "./entry.ts";
import {
  TOOL_VERSION,
  STAGE2_COMMON,
  STAGE2_WORKFLOWS,
  STAGE4_TEMPLATES,
  TEMPLATE_DIR,
  readManifest,
  writeManifest,
  manifestWithStage,
  primaryStack,
  checkConsistency,
  renderWorkflow,
  type ManifestConsistency,
  type GatesStrictness,
} from "./transform.ts";

const SCHEMA_VERSION = 1;

type FileStatus = "up-to-date" | "outdated" | "modified" | "missing" | "generated";

interface SyncFileReport {
  file: string;
  stage: number;
  status: FileStatus;
  /** recorded template version (outdated only — the version pair) */
  from: string | null;
  /** current template version (outdated only) */
  to: string | null;
}

interface SyncReport {
  schemaVersion: number;
  root: string;
  dryRun: boolean;
  version: { installed: string | null; current: string };
  files: SyncFileReport[];
  applied: boolean;
  consistency: ManifestConsistency | null;
  message: string | null;
}

interface ManifestEntry {
  stage: number;
  file: string;
  /** template file in templates/, null when not template-managed (e.g. AGENTS.md) */
  template: string | null;
  templateVersion: string;
  /** Gate strictness the installed workflow was rendered with (stage-2
   *  manifest record; absent for non-workflow files / pre-0008 installs). */
  gates?: GatesStrictness;
}

/** Dotted numeric version compare: "0.9.0" < "0.10.0" (true); non-numeric → string fallback. */
function versionLt(a: string, b: string): boolean {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10));
  const pb = b.split(".").map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a < b;
    if (x !== y) return x < y;
  }
  return false;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function templateContent(name: string): string {
  return readFileSync(join(TEMPLATE_DIR, name), "utf8");
}

/** Template file for an install path, or null when not template-managed
 *  (e.g. AGENTS.md). The workflow template resolves by primary stack (decision #13). */
function templateFor(file: string, root: string): string | null {
  const common = STAGE2_COMMON[file];
  if (common) return common;
  if (file === ".github/workflows/ai-native.yml") {
    const stack = primaryStack(root);
    return stack ? STAGE2_WORKFLOWS[stack] : null;
  }
  return STAGE4_TEMPLATES[file] ?? null;
}

/** Every manifest file entry across stages (stage ascending, then file). */
function manifestEntries(
  manifest: { stages: Record<string, { files: string[]; templateVersion?: string; gates?: GatesStrictness }> },
  root: string,
): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  for (const [k, s] of Object.entries(manifest.stages)) {
    const stage = Number.parseInt(k, 10);
    for (const file of s.files) {
      out.push({
        stage,
        file,
        template: templateFor(file, root),
        templateVersion: s.templateVersion ?? TOOL_VERSION,
        // The workflow is the only template file whose installed bytes depend
        // on the strictness render — carry the stage-2 record through classify.
        gates: file === ".github/workflows/ai-native.yml" ? s.gates : undefined,
      });
    }
  }
  return out.sort((a, b) => a.stage - b.stage || a.file.localeCompare(b.file));
}

/** The template bytes an installed file is compared against — the workflow
 *  compares against its recorded strictness render, everything else verbatim. */
function currentBytes(e: ManifestEntry): string {
  const tpl = templateContent(e.template as string);
  return e.gates && e.file === ".github/workflows/ai-native.yml" ? renderWorkflow(tpl, e.gates) : tpl;
}

/** Deterministic per-file classification (byte comparison + version comparison). */
function classify(root: string, e: ManifestEntry): SyncFileReport {
  if (!e.template) return { file: e.file, stage: e.stage, status: "generated", from: null, to: null };
  const target = join(root, e.file);
  if (!existsSync(target)) return { file: e.file, stage: e.stage, status: "missing", from: null, to: null };
  if (readFileSync(target, "utf8") === currentBytes(e)) {
    return { file: e.file, stage: e.stage, status: "up-to-date", from: null, to: null };
  }
  if (versionLt(e.templateVersion, TOOL_VERSION)) {
    return { file: e.file, stage: e.stage, status: "outdated", from: e.templateVersion, to: TOOL_VERSION };
  }
  // same-version diff → user edits, never overwritten (decision: conservative)
  return { file: e.file, stage: e.stage, status: "modified", from: null, to: null };
}

/** Outdated template files only — the check.ts integration point (no writes). */
export function outdatedTemplates(root: string): SyncFileReport[] {
  const mr = readManifest(root);
  if (!mr.present || !mr.manifest) return [];
  return manifestEntries(mr.manifest, root)
    .map((e) => classify(root, e))
    .filter((f) => f.status === "outdated");
}

export function run(root: string, dryRun: boolean): SyncReport {
  const mr = readManifest(root);
  if (!mr.present || !mr.manifest) {
    return {
      schemaVersion: SCHEMA_VERSION,
      root,
      dryRun,
      version: { installed: null, current: TOOL_VERSION },
      files: [],
      applied: false,
      consistency: null,
      message: mr.present
        ? `manifest unreadable (${mr.error}) — fix or re-run transform`
        : "no .ai-native.yml manifest — run transform stage 2 first",
    };
  }

  const pairs = manifestEntries(mr.manifest, root).map((entry) => ({ entry, report: classify(root, entry) }));
  const files = pairs.map((p) => p.report);
  const count = (s: FileStatus) => files.filter((f) => f.status === s).length;
  const toApply = pairs.filter((p) => p.report.status === "outdated" || p.report.status === "missing");

  if (dryRun) {
    return {
      schemaVersion: SCHEMA_VERSION,
      root,
      dryRun: true,
      version: { installed: mr.manifest.version, current: TOOL_VERSION },
      files,
      applied: false,
      consistency: checkConsistency(root),
      message:
        `dry-run: ${count("outdated")} outdated (apply replaces), ${count("missing")} missing (apply restores), ` +
        `${count("modified")} modified (user edits — never touched), ${count("generated")} generated (not template-managed), ${files.length} tracked file(s)`,
    };
  }

  // Apply: replace outdated + restore missing with current template bytes
  // (the workflow re-rendered at the manifest's recorded strictness — a hard
  // install must not be silently downgraded to warn-only); never touch modified.
  const touchedStages = new Set<number>();
  for (const { entry } of toApply) {
    mkdirSync(join(root, entry.file, ".."), { recursive: true });
    writeFileSync(join(root, entry.file), currentBytes(entry), "utf8");
    touchedStages.add(entry.stage);
  }
  // Version-record reconciliation: a stage whose files all match the current
  // templates but is recorded at an older version gets restamped — the ledger
  // must not under-report files that are byte-current. Only fires when records
  // diverge (in-sync repos write nothing); stages with modified/missing files
  // keep their record.
  for (const [k, s] of Object.entries(mr.manifest.stages)) {
    const stage = Number.parseInt(k, 10);
    if (touchedStages.has(stage) || s.templateVersion === undefined || !versionLt(s.templateVersion, TOOL_VERSION))
      continue;
    const managed = files.filter((f) => f.stage === stage && f.status !== "generated");
    if (managed.length > 0 && managed.every((f) => f.status === "up-to-date")) {
      writeManifest(root, manifestWithStage(root, k, { ...s, date: today(), templateVersion: TOOL_VERSION }));
      touchedStages.add(stage);
    }
  }
  // Stamp the touched stages with the current template version (the re-sync record).
  for (const stage of [...touchedStages].sort()) {
    const current = mr.manifest.stages[String(stage)];
    writeManifest(
      root,
      manifestWithStage(root, String(stage), { ...current, date: today(), templateVersion: TOOL_VERSION }),
    );
  }

  const parts: string[] = [];
  if (toApply.length === 0) {
    const modified = count("modified");
    parts.push(
      modified > 0
        ? `in sync: ${modified} modified file(s) left untouched (user edits)`
        : `in sync: all ${files.length} tracked file(s) match the current templates`,
    );
  } else {
    const replaced = toApply.map((p) => p.report.file).join(", ");
    parts.push(`replaced/restored ${toApply.length} file(s): ${replaced}`);
    parts.push(
      "outdated = old-version byte diff — user edits on an OLD-version install are replaced too; dry-run first to preview",
    );
    if (count("modified") > 0) parts.push(`${count("modified")} modified file(s) left untouched (user edits)`);
    parts.push("manifest updated (templateVersion)");
    parts.push(`rollback: git restore ${toApply.map((p) => p.report.file).join(" ")}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    root,
    dryRun: false,
    version: { installed: mr.manifest.version, current: TOOL_VERSION },
    files,
    applied: toApply.length > 0,
    consistency: checkConsistency(root),
    message: parts.join("; "),
  };
}

// --- rendering -----------------------------------------------------------------

function renderMarkdown(r: SyncReport): string {
  const lines: string[] = ["# Sync Report", ""];
  const installed = r.version.installed ?? "none";
  lines.push(
    `- Root: ${r.root} · Dry-run: ${r.dryRun} · Templates: installed ${installed} → current ${r.version.current}`,
    "",
  );
  if (r.files.length === 0) {
    lines.push("- No tracked template files.", "");
  } else {
    lines.push("| File | Stage | Status | Version |", "|---|---|---|---|");
    for (const f of r.files) {
      const ver = f.status === "outdated" ? `${f.from} → ${f.to}` : "—";
      lines.push(`| ${f.file} | ${f.stage} | ${f.status} | ${ver} |`);
    }
    lines.push("");
  }
  if (r.consistency) {
    lines.push(
      r.consistency.consistent
        ? "- Manifest consistency: consistent"
        : `- Manifest consistency: DIVERGENT — missing: ${r.consistency.missing.join(", ")}`,
      "",
    );
  }
  if (r.message) lines.push(r.message, "");
  return lines.join("\n");
}

// --- CLI ------------------------------------------------------------------------

function parseArgs(argv: string[]): { root: string; dryRun: boolean; format: "json" | "markdown" } {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} requires a value`);
    return v;
  };
  const format = valueOf("--format") === "markdown" ? "markdown" : "json";
  return { root: valueOf("--root") ?? process.cwd(), dryRun: argv.includes("--dry-run"), format };
}

function assertNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok =
    major > 24 || (major === 24 && minor >= 12) || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  if (!ok) {
    console.error(
      `sync: Node.js >= 22.18 required (native type stripping); found ${process.versions.node}.\n` +
        "Upgrade Node, e.g. via your version manager (nvm install --lts).",
    );
    process.exit(1);
  }
}

// CLI entry: runs only when executed directly (importing must not trigger side effects)
if (isDirectEntry(import.meta.url)) {
  assertNodeVersion();
  try {
    const { root, dryRun, format } = parseArgs(process.argv.slice(2));
    const report = run(root, dryRun);
    process.stdout.write(format === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    console.error(`sync: ${(err as Error).message}`);
    process.exit(1);
  }
}
