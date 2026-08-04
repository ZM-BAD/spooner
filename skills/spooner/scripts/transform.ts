#!/usr/bin/env node
/**
 * transform — Spooner M2: CLI + manifest model + stage status + stage 2
 * gates installer (warn-only, build-green verified) + stage 3 agent files
 * (AGENTS.md from real commands + CLAUDE.md bridge) + stage 4 SDD adoption
 * (docs/sdd/ templates + AGENTS.md convention + CI gate).
 *
 * Agent-driven workflow (specs/0002-m2-transform/spec.md): stage 1 = audit
 * (M1, existing); stages 2-4 apply verified, confirmable changes.
 *
 * Zero dependencies (Node builtins only); runs natively via Node's
 * type stripping — no build step:
 *   node skills/spooner/scripts/transform.ts [--root <path>] [--stage 2|3|4|all] [--dry-run] [--format json|markdown]
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detect } from "./detect.ts";

const MANIFEST_FILE = ".ai-native.yml";
const SCHEMA_VERSION = 1;
const TOOL_NAME = "spooner";
const TOOL_VERSION = "0.2.2";

/** Output files per stage (pinned in specs/0002 §per-stage outputs). */
const STAGE_FILES: Record<number, string[]> = {
  2: [".commitlintrc.json", ".pre-commit-config.yaml", ".markdownlint-cli2.yaml", ".github/workflows/ai-native.yml"],
  3: ["AGENTS.md", "CLAUDE.md"],
  4: ["docs/sdd/spec.md", "docs/sdd/plan.md", "docs/sdd/tasks.md", ".github/workflows/sdd.yml"],
};

interface ManifestStage {
  date: string;
  warnOnly?: boolean;
  files: string[];
}

interface Manifest {
  schemaVersion: number;
  tool: string;
  version: string;
  stages: Record<string, ManifestStage>;
}

type StageStatus = "installed" | "partial" | "not-installed";

interface StageReport {
  stage: number;
  status: StageStatus;
  present: string[];
  missing: string[];
}

interface TransformReport {
  schemaVersion: number;
  root: string;
  stage: number | "all";
  dryRun: boolean;
  stages: StageReport[];
  manifest: { present: boolean; error: string | null };
  consistency: ManifestConsistency | null;
  applied: boolean;
  message: string | null;
  manifestUpdated: boolean | null;
  /** stage 2/3 apply details (null for other stages) */
  files: Stage2FilePlan[] | Stage3FilePlan[] | null;
  buildCheck: BuildCheck | null;
}

// --- minimal YAML subset (pinned manifest schema only; zero deps) ------------

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

function parseScalar(raw: string): YamlValue {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  const quoted = v.match(/^"([^"]*)"$/) ?? v.match(/^'([^']*)'$/);
  if (quoted) return quoted[1];
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseYaml(text: string): { [k: string]: YamlValue } {
  const lines = text.split("\n").map((l) => ({ indent: l.length - l.trimStart().length, raw: l }));
  let i = 0;

  function parseBlock(indent: number): { [k: string]: YamlValue } | YamlValue[] {
    const obj: { [k: string]: YamlValue } = {};
    const arr: YamlValue[] = [];
    let isArray = false;
    while (i < lines.length) {
      const { indent: ind, raw } = lines[i];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        i++;
        continue;
      }
      if (ind < indent) break;
      if (ind > indent) throw new Error(`unexpected indent at "${trimmed}"`);
      if (trimmed.startsWith("- ")) {
        isArray = true;
        arr.push(parseScalar(trimmed.slice(2)));
        i++;
        continue;
      }
      if (isArray) throw new Error(`mixed map/array at "${trimmed}"`);
      const m = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (!m) throw new Error(`cannot parse line "${trimmed}"`);
      const key = m[1].trim();
      const rest = m[2].trim();
      if (rest === "") {
        i++;
        if (i < lines.length && lines[i].indent > ind) {
          obj[key] = parseBlock(lines[i].indent);
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseScalar(rest);
        i++;
      }
    }
    return isArray ? arr : obj;
  }

  const root = parseBlock(0);
  return (root as { [k: string]: YamlValue }) ?? {};
}

function stringifyManifest(m: Manifest): string {
  const lines: string[] = [`schemaVersion: ${m.schemaVersion}`, `tool: ${m.tool}`, `version: "${m.version}"`, "stages:"];
  for (const [stage, s] of Object.entries(m.stages)) {
    lines.push(`  ${stage}:`, `    date: "${s.date}"`);
    if (s.warnOnly !== undefined) lines.push(`    warnOnly: ${s.warnOnly}`);
    lines.push("    files:");
    for (const f of s.files) lines.push(`      - "${f}"`);
  }
  return `${lines.join("\n")}\n`;
}

// --- manifest model -----------------------------------------------------------

export function readManifest(root: string): { present: boolean; manifest: Manifest | null; error: string | null } {
  const p = join(root, MANIFEST_FILE);
  if (!existsSync(p)) return { present: false, manifest: null, error: null };
  try {
    const parsed = parseYaml(readFileSync(p, "utf8"));
    const stagesRaw = parsed["stages"];
    if (parsed["schemaVersion"] !== SCHEMA_VERSION || parsed["tool"] !== TOOL_NAME || typeof stagesRaw !== "object" || stagesRaw === null || Array.isArray(stagesRaw)) {
      throw new Error(`schema mismatch (expected schemaVersion ${SCHEMA_VERSION}, tool ${TOOL_NAME}, stages map)`);
    }
    const stages: Record<string, ManifestStage> = {};
    for (const [k, v] of Object.entries(stagesRaw)) {
      const s = v as { date?: unknown; warnOnly?: unknown; files?: unknown };
      if (typeof s !== "object" || s === null || typeof s.date !== "string" || !Array.isArray(s.files) || s.files.some((f) => typeof f !== "string")) {
        throw new Error(`stage "${k}" entry malformed`);
      }
      stages[k] = { date: s.date, files: s.files as string[], warnOnly: s.warnOnly === true ? true : undefined };
    }
    return {
      present: true,
      manifest: {
        schemaVersion: parsed["schemaVersion"] as number,
        tool: parsed["tool"] as string,
        version: typeof parsed["version"] === "string" ? parsed["version"] : TOOL_VERSION,
        stages,
      },
      error: null,
    };
  } catch (err) {
    return { present: true, manifest: null, error: (err as Error).message };
  }
}

/** Written by every applied stage (slices 2-4); idempotent by design. */
export function writeManifest(root: string, stages: Record<string, ManifestStage>): void {
  writeFileSync(join(root, MANIFEST_FILE), stringifyManifest({ schemaVersion: SCHEMA_VERSION, tool: TOOL_NAME, version: TOOL_VERSION, stages }), "utf8");
}

// --- stage 2: gates installer ---------------------------------------------------

/** Install path → template file (verbatim copies, zero parameters, v1). */
const STAGE2_TEMPLATES: Record<string, string> = {
  ".commitlintrc.json": "commitlintrc.json",
  ".pre-commit-config.yaml": "pre-commit-config.yaml",
  ".markdownlint-cli2.yaml": "markdownlint-cli2.yaml",
  ".github/workflows/ai-native.yml": "ci-workflow.yml",
};

const TEMPLATE_DIR = join(import.meta.dirname, "..", "templates");

interface Stage2FilePlan {
  file: string;
  action: "write" | "keep" | "conflict";
}

interface Stage3FilePlan {
  file: string;
  action: "write" | "link" | "keep" | "conflict";
}

interface BuildCheck {
  command: string | null;
  before: boolean | null;
  after: boolean | null;
}

interface Stage2Result {
  stage: 2;
  applied: boolean;
  dryRun: boolean;
  files: Stage2FilePlan[];
  buildCheck: BuildCheck;
  manifestUpdated: boolean;
  message: string | null;
}

function templateContent(name: string): string {
  return readFileSync(join(TEMPLATE_DIR, name), "utf8");
}

function packageJsonOf(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Declared build-ish and test-ish npm scripts (same key families as the audit). */
function declaredBuildTest(root: string): { build: string | null; test: string | null } {
  const pkg = packageJsonOf(root);
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {};
  const build = ["build", "compile", "typecheck", "check", "verify"].find((k) => typeof scripts[k] === "string") ?? null;
  const test = ["test", "spec"].find((k) => typeof scripts[k] === "string") ?? null;
  return { build, test };
}

function runNpm(root: string, key: string): boolean {
  try {
    execFileSync("npm", ["run", key], { cwd: root, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function runDeclared(root: string): { ok: boolean; keys: string[] } {
  const { build, test } = declaredBuildTest(root);
  const keys = [build, test].filter((k): k is string => k !== null);
  for (const k of keys) {
    if (!runNpm(root, k)) return { ok: false, keys };
  }
  return { ok: true, keys };
}

function manifestWithStage(root: string, stage: string, entry: ManifestStage): Record<string, ManifestStage> {
  const mr = readManifest(root);
  const merged: Record<string, ManifestStage> = { ...(mr.present && mr.manifest ? mr.manifest.stages : {}) };
  merged[stage] = entry;
  return merged;
}

function applyStage2(root: string, dryRun: boolean): Stage2Result {
  const plans: Stage2FilePlan[] = Object.entries(STAGE2_TEMPLATES).map(([file, tpl]) => {
    const target = join(root, file);
    if (!existsSync(target)) return { file, action: "write" };
    return readFileSync(target, "utf8") === templateContent(tpl) ? { file, action: "keep" } : { file, action: "conflict" };
  });
  const toWrite = plans.filter((p) => p.action === "write");
  const conflicts = plans.filter((p) => p.action === "conflict");
  const { build, test } = declaredBuildTest(root);
  const command = [build && `npm run ${build}`, test && `npm run ${test}`].filter(Boolean).join(" && ") || null;

  if (dryRun) {
    return {
      stage: 2,
      applied: false,
      dryRun: true,
      files: plans,
      buildCheck: { command, before: null, after: null },
      manifestUpdated: false,
      message: `dry-run: ${toWrite.length} file(s) to write, ${conflicts.length} conflict(s), ${plans.length - toWrite.length - conflicts.length} already installed; verification command: ${command ?? "none declared"}`,
    };
  }

  const before = command ? runDeclared(root).ok : null;
  for (const p of toWrite) {
    mkdirSync(join(root, p.file, ".."), { recursive: true });
    writeFileSync(join(root, p.file), templateContent(STAGE2_TEMPLATES[p.file]), "utf8");
  }
  const after = command ? runDeclared(root).ok : null;
  const manifestUpdated = toWrite.length > 0;

  if (manifestUpdated) {
    writeManifest(
      root,
      manifestWithStage(root, "2", {
        date: new Date().toISOString().slice(0, 10),
        warnOnly: true,
        files: Object.keys(STAGE2_TEMPLATES),
      }),
    );
  }

  let message: string;
  if (toWrite.length === 0 && conflicts.length === 0) {
    message = "stage 2 already installed (no changes)";
  } else if (after === false) {
    const written = toWrite.map((p) => p.file).join(", ");
    message =
      before === false
        ? `stage 2 applied: build was ALREADY failing before apply (pre-existing); ${written} written; verification still failing after`
        : `stage 2 applied but build verification FAILED after — rollback: git restore ${written}`;
  } else {
    const parts: string[] = [];
    if (toWrite.length > 0) parts.push(`${toWrite.length} file(s) written`);
    if (conflicts.length > 0) parts.push(`${conflicts.length} conflict(s) kept (existing config differs — not overwritten: ${conflicts.map((c) => c.file).join(", ")})`);
    if (before === null) parts.push("no build/test command declared — nothing to verify");
    else parts.push(`build green before+after (${command})`);
    message = `stage 2 applied: ${parts.join("; ")}${manifestUpdated ? "; manifest updated" : ""}`;
  }

  return { stage: 2, applied: toWrite.length > 0, dryRun: false, files: plans, buildCheck: { command, before, after }, manifestUpdated, message };
}

// --- stage 3: agent files --------------------------------------------------------

interface Stage3Result {
  stage: 3;
  applied: boolean;
  dryRun: boolean;
  files: Stage3FilePlan[];
  manifestUpdated: boolean;
  message: string | null;
}

function makefileTargetsOf(root: string): string[] {
  try {
    return readFileSync(join(root, "Makefile"), "utf8")
      .split("\n")
      .filter((l) => /^[a-zA-Z0-9_.-]+\s*:/.test(l))
      .map((l) => l.split(":")[0].trim());
  } catch {
    return [];
  }
}

/**
 * Deterministic AGENTS.md generation: every command traces to a real file
 * (package.json scripts / Makefile). Nothing is invented — the killer gate.
 */
export function generateAgentsMd(root: string): string {
  const pkg = packageJsonOf(root);
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {};
  const stacks = detect(root).stacks;
  const name = typeof pkg?.name === "string" && pkg.name ? pkg.name : basename(root);
  const description = typeof pkg?.description === "string" ? pkg.description : null;
  const scriptKeys = Object.keys(scripts).sort();
  const makeTargets = makefileTargetsOf(root);
  const lines: string[] = [
    `# ${name} — agent contract`,
    "",
    "> Generated by spooner transform Stage 3. Every command below is",
    "> traceable to a real file (package.json scripts / Makefile) — nothing",
    "> is invented.",
    "",
    "## Overview",
    "",
    description ?? `Repository: ${name} — see README.md for human-facing docs.`,
    "",
    "## Stack",
    "",
    `- ${stacks.length > 0 ? stacks.join(", ") : "unknown (no standard manifest found)"}`,
    "",
    "## Commands (all real and executable)",
    "",
  ];
  if (scriptKeys.length === 0 && makeTargets.length === 0) {
    lines.push("- None declared. Add build/test commands (e.g. package.json scripts) to unlock the gates.", "");
  } else {
    lines.push("| Command | Purpose |", "|---|---|");
    for (const k of scriptKeys) lines.push(`| \`npm run ${k}\` | ${k} |`);
    for (const t of makeTargets) lines.push(`| \`make ${t}\` | Makefile target |`);
    lines.push("");
  }
  lines.push("## Conventions", "");
  lines.push("- Follow the repo's existing conventions; keep the build green.", "");
  return lines.join("\n");
}

function applyStage3(root: string, dryRun: boolean): Stage3Result {
  const generated = generateAgentsMd(root);
  const agentsPath = join(root, "AGENTS.md");
  const claudePath = join(root, "CLAUDE.md");

  const agentsAction: Stage3FilePlan = !existsSync(agentsPath)
    ? { file: "AGENTS.md", action: "write" }
    : readFileSync(agentsPath, "utf8") === generated
      ? { file: "AGENTS.md", action: "keep" }
      : { file: "AGENTS.md", action: "conflict" };

  const claudeAction: Stage3FilePlan = (() => {
    if (!existsSync(claudePath)) return { file: "CLAUDE.md", action: "link" };
    try {
      if (lstatSync(claudePath).isSymbolicLink() && readlinkSync(claudePath) === "AGENTS.md") return { file: "CLAUDE.md", action: "keep" };
    } catch {
      /* not a symlink — fall through to content check */
    }
    return /@AGENTS\.md|AGENTS\.md/i.test(readFileSync(claudePath, "utf8"))
      ? { file: "CLAUDE.md", action: "keep" }
      : { file: "CLAUDE.md", action: "conflict" };
  })();

  const plans = [agentsAction, claudeAction];
  if (dryRun) {
    return {
      stage: 3,
      applied: false,
      dryRun: true,
      files: plans,
      manifestUpdated: false,
      message: `dry-run: AGENTS.md ${agentsAction.action}, CLAUDE.md ${claudeAction.action}`,
    };
  }

  if (agentsAction.action === "write") writeFileSync(agentsPath, generated, "utf8");
  if (claudeAction.action === "link") {
    if (process.platform === "win32") writeFileSync(claudePath, "@AGENTS.md\n", "utf8");
    else symlinkSync("AGENTS.md", claudePath);
  }

  const manifestUpdated = agentsAction.action === "write" || claudeAction.action === "link";
  if (manifestUpdated) {
    writeManifest(
      root,
      manifestWithStage(root, "3", { date: new Date().toISOString().slice(0, 10), files: ["AGENTS.md", "CLAUDE.md"] }),
    );
  }

  const conflicts = plans.filter((f) => f.action === "conflict");
  let message: string;
  if (!manifestUpdated && conflicts.length === 0) {
    message = "stage 3 already installed (no changes)";
  } else if (conflicts.length > 0) {
    message = `stage 3 applied: ${manifestUpdated ? "files written; " : ""}conflict(s) kept (not overwritten: ${conflicts.map((c) => c.file).join(", ")})`;
  } else {
    const agents = agentsAction.action === "write" ? `written (${generated.split("\n").length} lines)` : "kept";
    const claude = claudeAction.action === "link" ? (process.platform === "win32" ? "@AGENTS.md import written" : "symlinked to AGENTS.md") : "kept";
    message = `stage 3 applied: AGENTS.md ${agents}; CLAUDE.md ${claude}; manifest updated`;
  }
  return { stage: 3, applied: manifestUpdated, dryRun: false, files: plans, manifestUpdated, message };
}

// --- stage 4: SDD adoption ---------------------------------------------------------

/** Install path → template file. */
const STAGE4_TEMPLATES: Record<string, string> = {
  "docs/sdd/spec.md": "sdd/spec.md",
  "docs/sdd/plan.md": "sdd/plan.md",
  "docs/sdd/tasks.md": "sdd/tasks.md",
  ".github/workflows/sdd.yml": "sdd-ci-workflow.yml",
};

/** Appended to AGENTS.md (additive, idempotent via the SDD marker). */
const SDD_CONVENTION = `## Spec-driven workflow (SDD)

- Every feature starts as a spec: \`docs/sdd/spec.md\` (proposed → approved → in-progress → shipped)
- Implement in independently verifiable slices (docs/sdd/plan.md), tracked in docs/sdd/tasks.md
- The sdd CI gate fails when spec files are missing — specs are first-class
`;

interface Stage4Result {
  stage: 4;
  applied: boolean;
  dryRun: boolean;
  files: Stage2FilePlan[];
  agentsSdd: { plan: "append" | "already-present" | "no-agents-file"; appended: boolean };
  manifestUpdated: boolean;
  message: string | null;
}

function applyStage4(root: string, dryRun: boolean): Stage4Result {
  const plans: Stage2FilePlan[] = Object.entries(STAGE4_TEMPLATES).map(([file, tpl]) => {
    const target = join(root, file);
    if (!existsSync(target)) return { file, action: "write" };
    return readFileSync(target, "utf8") === templateContent(tpl) ? { file, action: "keep" } : { file, action: "conflict" };
  });
  const toWrite = plans.filter((p) => p.action === "write");
  const conflicts = plans.filter((p) => p.action === "conflict");

  const agentsPath = join(root, "AGENTS.md");
  let agentsSdd: Stage4Result["agentsSdd"];
  if (!existsSync(agentsPath)) {
    agentsSdd = { plan: "no-agents-file", appended: false };
  } else if (/\bspec\b|spec-driven|\bSDD\b(?!-)/i.test(readFileSync(agentsPath, "utf8"))) {
    agentsSdd = { plan: "already-present", appended: false };
  } else {
    agentsSdd = { plan: "append", appended: false };
  }

  if (dryRun) {
    const agentsPlan = agentsSdd.plan === "append" ? "append" : agentsSdd.plan === "already-present" ? "already present" : "skipped (no AGENTS.md — run stage 3)";
    return {
      stage: 4,
      applied: false,
      dryRun: true,
      files: plans,
      agentsSdd,
      manifestUpdated: false,
      message: `dry-run: ${toWrite.length} file(s) to write, ${conflicts.length} conflict(s), ${plans.length - toWrite.length - conflicts.length} already installed; AGENTS.md SDD convention: ${agentsPlan}`,
    };
  }

  for (const p of toWrite) {
    mkdirSync(join(root, p.file, ".."), { recursive: true });
    writeFileSync(join(root, p.file), templateContent(STAGE4_TEMPLATES[p.file]), "utf8");
  }
  let appended = false;
  if (agentsSdd.plan === "append") {
    writeFileSync(agentsPath, `${readFileSync(agentsPath, "utf8").replace(/\s+$/, "")}\n\n${SDD_CONVENTION}`, "utf8");
    appended = true;
    agentsSdd = { plan: "append", appended: true };
  }

  const manifestUpdated = toWrite.length > 0 || appended;
  if (manifestUpdated) {
    const files = [...Object.keys(STAGE4_TEMPLATES), ...(appended ? ["AGENTS.md"] : [])];
    writeManifest(root, manifestWithStage(root, "4", { date: new Date().toISOString().slice(0, 10), files }));
  }

  let message: string;
  if (toWrite.length === 0 && conflicts.length === 0 && !appended) {
    message = "stage 4 already installed (no changes)";
  } else if (conflicts.length > 0) {
    message = `stage 4 applied: ${toWrite.length > 0 || appended ? "changes written; " : ""}conflict(s) kept (not overwritten: ${conflicts.map((c) => c.file).join(", ")})`;
  } else {
    const parts: string[] = [];
    if (toWrite.length > 0) parts.push(`${toWrite.length} file(s) written`);
    if (appended) parts.push("AGENTS.md SDD convention appended");
    if (agentsSdd.plan === "already-present") parts.push("AGENTS.md already declares SDD");
    if (agentsSdd.plan === "no-agents-file") parts.push("AGENTS.md missing — run stage 3 first");
    message = `stage 4 applied: ${parts.join("; ")}${manifestUpdated ? "; manifest updated" : ""}`;
  }
  return { stage: 4, applied: manifestUpdated, dryRun: false, files: plans, agentsSdd, manifestUpdated, message };
}

interface ManifestConsistency {
  checked: boolean;
  consistent: boolean;
  missing: string[];
}

/** Manifest entries vs actual files — the drift seed for the future check command. */
function checkConsistency(root: string): ManifestConsistency | null {
  const mr = readManifest(root);
  if (!mr.present || !mr.manifest) return null;
  const missing = new Set<string>();
  for (const entry of Object.values(mr.manifest.stages)) {
    for (const f of entry.files) {
      if (!existsSync(join(root, f))) missing.add(f);
    }
  }
  const sorted = [...missing].sort();
  return { checked: true, consistent: sorted.length === 0, missing: sorted };
}

// --- stage status -------------------------------------------------------------

function stageStatus(root: string, stage: number): StageReport {
  const files = STAGE_FILES[stage];
  const present = files.filter((f) => existsSync(join(root, f)));
  const missing = files.filter((f) => !present.includes(f));
  const status: StageStatus = present.length === 0 ? "not-installed" : missing.length === 0 ? "installed" : "partial";
  return { stage, status, present, missing };
}

function run(root: string, stage: number | "all", dryRun: boolean): TransformReport {
  const stagesToReport = stage === "all" ? [2, 3, 4] : [stage];
  const mr = readManifest(root);
  let applied = false;
  let message: string | null = null;
  let manifestUpdated: boolean | null = null;
  let files: Stage2FilePlan[] | Stage3FilePlan[] | null = null;
  let buildCheck: BuildCheck | null = null;
  if (stage === 2) {
    const r2 = applyStage2(root, dryRun);
    applied = r2.applied;
    message = r2.message;
    manifestUpdated = r2.manifestUpdated;
    files = r2.files;
    buildCheck = r2.buildCheck;
  } else if (stage === 3) {
    const r3 = applyStage3(root, dryRun);
    applied = r3.applied;
    message = r3.message;
    manifestUpdated = r3.manifestUpdated;
    files = r3.files;
  } else if (stage === 4) {
    const r4 = applyStage4(root, dryRun);
    applied = r4.applied;
    message = r4.message;
    manifestUpdated = r4.manifestUpdated;
    files = r4.files;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    root: ".",
    stage,
    dryRun,
    stages: stagesToReport.map((s) => stageStatus(root, s)),
    manifest: { present: mr.present, error: mr.error },
    consistency: checkConsistency(root),
    applied,
    message,
    manifestUpdated,
    files,
    buildCheck,
  };
}

// --- rendering -----------------------------------------------------------------

function renderMarkdown(r: TransformReport): string {
  const lines: string[] = ["# Transform Status", ""];
  lines.push(`- Root: ${r.root} · Stage: ${r.stage} · Dry-run: ${r.dryRun}`, "");
  if (r.manifest.error) lines.push(`> manifest error: ${r.manifest.error}`, "");
  lines.push("| Stage | Status | Present | Missing |", "|---|---|---|---|");
  for (const s of r.stages) {
    lines.push(`| ${s.stage} | ${s.status} | ${s.present.join(", ") || "—"} | ${s.missing.join(", ") || "—"} |`);
  }
  lines.push("");
  if (r.files) {
    lines.push("| File | Action |", "|---|---|");
    for (const f of r.files) lines.push(`| ${f.file} | ${f.action} |`);
    lines.push("");
  }
  if (r.consistency) {
    lines.push(
      `- Manifest consistency: ${r.consistency.consistent ? "consistent" : `DIVERGENT — missing: ${r.consistency.missing.join(", ")}`}`,
      "",
    );
  }
  if (r.buildCheck && r.buildCheck.command) {
    lines.push(`- Build verification (${r.buildCheck.command}): before ${r.buildCheck.before ?? "—"} / after ${r.buildCheck.after ?? "—"}`, "");
  }
  if (r.message) lines.push(r.message, "");
  return lines.join("\n");
}

// --- CLI ------------------------------------------------------------------------

function parseArgs(argv: string[]): { root: string; stage: number | "all"; dryRun: boolean; format: "json" | "markdown" } {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const stageRaw = valueOf("--stage");
  const stage: number | "all" =
    stageRaw === undefined || stageRaw === "all"
      ? "all"
      : (() => {
          const n = Number.parseInt(stageRaw, 10);
          if (n === 2 || n === 3 || n === 4) return n;
          throw new Error(`invalid --stage "${stageRaw}" (expected 2, 3, 4, or all)`);
        })();
  const format = valueOf("--format") === "markdown" ? "markdown" : "json";
  return { root: valueOf("--root") ?? process.cwd(), stage, dryRun: argv.includes("--dry-run"), format };
}

function assertNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok =
    major > 24 ||
    (major === 24 && minor >= 12) ||
    (major === 23 && minor >= 6) ||
    (major === 22 && minor >= 18);
  if (!ok) {
    console.error(
      `transform: Node.js >= 22.18 required (native type stripping); found ${process.versions.node}.\n` +
        "Upgrade Node, e.g. via your version manager (nvm install --lts).",
    );
    process.exit(1);
  }
}

// CLI entry: runs only when executed directly (importing must not trigger side effects)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  assertNodeVersion();
  try {
    const { root, stage, dryRun, format } = parseArgs(process.argv.slice(2));
    const report = run(root, stage, dryRun);
    process.stdout.write(format === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
    // applied but the post-apply build check failed → signal rollback
    if (report.applied && report.buildCheck?.after === false) process.exit(1);
  } catch (err) {
    console.error(`transform: ${(err as Error).message}`);
    process.exit(1);
  }
}
