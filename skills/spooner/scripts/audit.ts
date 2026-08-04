#!/usr/bin/env node
/**
 * audit — Spooner M1 slices 2-3: AI-Readiness scoring engine.
 *
 * Scores a repository against the v1 scoring matrix defined in
 * specs/0001-m1-audit-core/spec.md (20 points across 5 categories,
 * 19 checks), plus the maturity gating rules from the internal
 * design archive (local-only).
 *
 * Every check must be backed by real evidence (file paths, git state,
 * or commands traceable to manifests) — no invented facts.
 *
 * Zero dependencies (Node builtins + git only); runs natively via Node's
 * type stripping — no build step:
 *   node skills/spooner/scripts/audit.ts [--root <path>] [--format json|markdown]
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detect } from "./detect.ts";

const SCORE_MAX = 20;

type Category = "agent-setup" | "configuration" | "integrity" | "freshness" | "structure";

interface CheckResult {
  id: string;
  category: Category;
  score: number;
  max: number;
  evidence: string;
  fix: string;
}

export interface AuditResult {
  schemaVersion: number;
  root: string;
  stacks: string[];
  maturity: "skeleton" | "stable" | "legacy";
  maturityNote: string | null;
  score: {
    total: number;
    max: number;
    byCategory: Record<Category, { score: number; max: number }>;
  };
  items: CheckResult[];
  gaps: string[];
  suggestions: string[];
}

const CATEGORY_ORDER: readonly Category[] = [
  "agent-setup",
  "configuration",
  "integrity",
  "freshness",
  "structure",
];

const CATEGORY_MAX: Record<Category, number> = {
  "agent-setup": 6,
  configuration: 5,
  integrity: 4,
  freshness: 3,
  structure: 2,
};

const CATEGORY_LABELS: Record<Category, string> = {
  "agent-setup": "Agent Setup",
  configuration: "Configuration",
  integrity: "Integrity",
  freshness: "Freshness",
  structure: "Structure",
};

/** Fixed suggestion copy per category (deterministic — no LLM generation). */
const SUGGESTIONS: Record<Category, string> = {
  "agent-setup": "Run transform Stage 3 to generate an AGENTS.md derived from real commands (with a CLAUDE.md symlink).",
  configuration: "Run transform Stage 2 to install lint/format/CI gates (warn-only; keep the existing build green).",
  integrity: "Run transform Stage 2 security pass: gitleaks, .env protection, and a CI security job.",
  freshness: "Freshness reflects maintenance activity and is not fixable by transform.",
  structure: "Add a README with real content and organize sources under src/, lib/, or packages/.",
};

// --- small utilities -------------------------------------------------------

function readIfExists(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function entriesOf(root: string): string[] | null {
  try {
    return readdirSync(root);
  } catch {
    return null;
  }
}

/** First top-level entry matching any pattern, or null. */
function hasPattern(root: string, patterns: RegExp[]): string | null {
  const entries = entriesOf(root);
  if (!entries) return null;
  for (const entry of entries) {
    if (patterns.some((p) => p.test(entry))) return entry;
  }
  return null;
}

/** Run git, return trimmed stdout, or null on any failure (e.g. not a repo). */
function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Run git, return true on exit code 0. */
function gitOk(root: string, args: string[]): boolean {
  try {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function packageJson(root: string): Record<string, unknown> | null {
  const raw = readIfExists(join(root, "package.json"));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageScripts(root: string): Record<string, string> {
  const scripts = packageJson(root)?.scripts;
  return typeof scripts === "object" && scripts !== null
    ? (scripts as Record<string, string>)
    : {};
}

function makefileTargets(root: string): string[] {
  const mk = readIfExists(join(root, "Makefile"));
  if (!mk) return [];
  return mk
    .split("\n")
    .filter((line) => /^[a-zA-Z0-9_.-]+\s*:/.test(line))
    .map((line) => line.split(":")[0].trim());
}

function scriptKey(root: string, pattern: RegExp): string | null {
  const key = Object.keys(packageScripts(root)).find((k) => pattern.test(k));
  return key ?? null;
}

function makefileTarget(root: string, name: string): boolean {
  return makefileTargets(root).includes(name);
}

function daysSince(epochSeconds: number): number {
  return (Date.now() / 1000 - epochSeconds) / 86400;
}

function lastCommitTs(root: string): number | null {
  const out = git(root, ["log", "-1", "--format=%ct"]);
  const ts = out ? Number.parseInt(out, 10) : Number.NaN;
  return Number.isNaN(ts) ? null : ts;
}

/** CI configuration files (GitHub Actions + common providers). */
function ciContent(root: string): string {
  const parts: string[] = [];
  const workflows = join(root, ".github", "workflows");
  for (const file of entriesOf(workflows) ?? []) {
    if (file.endsWith(".yml") || file.endsWith(".yaml")) {
      parts.push(readIfExists(join(workflows, file)) ?? "");
    }
  }
  for (const file of [
    ".gitlab-ci.yml",
    ".circleci/config.yml",
    ".travis.yml",
    "Jenkinsfile",
    "azure-pipelines.yml",
  ]) {
    parts.push(readIfExists(join(root, file)) ?? "");
  }
  // Filter empties: missing CI files must not inflate hasCi (joining
  // empty strings still yields newlines → length > 0 → false positive)
  return parts.filter((p) => p.length > 0).join("\n");
}

function hasCi(root: string): boolean {
  return ciContent(root).length > 0;
}

// --- checks: agent-setup (6) ----------------------------------------------

function agentFile(root: string): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const p = join(root, name);
    if (existsSync(p) && (lstatSync(p).isFile() || lstatSync(p).isSymbolicLink())) return name;
  }
  return null;
}

function checkAgentsMd(root: string): CheckResult {
  const file = agentFile(root);
  return {
    id: "agents-md",
    category: "agent-setup",
    score: file ? 1 : 0,
    max: 1,
    evidence: `agent file: ${file ?? "missing"}`,
    fix: "transform Stage 3",
  };
}

function checkAgentsBridge(root: string): CheckResult {
  const claude = join(root, "CLAUDE.md");
  let detail = "CLAUDE.md: missing";
  let score = 0;
  if (existsSync(claude)) {
    const isLink = lstatSync(claude).isSymbolicLink();
    const isFile = lstatSync(claude).isFile();
    const content = isFile ? readIfExists(claude) ?? "" : "";
    if (isLink) {
      detail = "CLAUDE.md: symlink to AGENTS.md";
      score = 1;
    } else if (/@AGENTS\.md|AGENTS\.md/i.test(content)) {
      detail = "CLAUDE.md: @AGENTS.md import bridge";
      score = 1;
    } else {
      detail = "CLAUDE.md: exists but no bridge to AGENTS.md";
    }
  }
  return { id: "agents-bridge", category: "agent-setup", score, max: 1, evidence: detail, fix: "transform Stage 3" };
}

function checkAgentsLength(root: string): CheckResult {
  const file = agentFile(root);
  if (!file) {
    return { id: "agents-length", category: "agent-setup", score: 0, max: 1, evidence: "no agent file", fix: "transform Stage 3" };
  }
  const content = readIfExists(join(root, file)) ?? "";
  const lines = content.split("\n").length;
  const bytes = Buffer.byteLength(content, "utf8");
  let score = 1;
  let detail = `${file}: ${lines} lines`;
  if (bytes > 40_000) {
    score = 0;
    detail = `${file}: ${bytes} chars exceeds the 40K hard block`;
  } else if (lines > 200) {
    score = 0.5;
    detail = `${file}: ${lines} lines exceeds the 200-line warning threshold`;
  }
  return { id: "agents-length", category: "agent-setup", score, max: 1, evidence: detail, fix: "trim AGENTS.md" };
}

function checkAgentsCommands(root: string): CheckResult {
  const buildKey = scriptKey(root, /^(build|compile|typecheck|check|verify)\b/);
  const testKey = scriptKey(root, /^(test|spec)\b/);
  const hasBuild = buildKey !== null || makefileTarget(root, "build");
  const hasTest = testKey !== null || makefileTarget(root, "test");
  const sources: string[] = [];
  if (buildKey || testKey) sources.push("package.json scripts");
  if (makefileTargets(root).length > 0) sources.push("Makefile");
  const evidence = sources.length > 0
    ? `commands traceable to ${sources.join(" + ")} (build: ${hasBuild}, test: ${hasTest})`
    : "no build/test commands found in package.json or Makefile";
  return {
    id: "agents-commands",
    category: "agent-setup",
    score: hasBuild && hasTest ? 2 : hasBuild || hasTest ? 1 : 0,
    max: 2,
    evidence,
    fix: "add real build/test commands, then document them in AGENTS.md",
  };
}

function checkAgentsSdd(root: string): CheckResult {
  const file = agentFile(root);
  const content = file ? readIfExists(join(root, file)) ?? "" : "";
  const mentions = /\bspec\b|spec-driven|\bSDD\b(?!-)/i.test(content);
  return {
    id: "agents-sdd",
    category: "agent-setup",
    score: mentions ? 1 : 0,
    max: 1,
    evidence: mentions ? "agent file declares a spec-driven workflow" : "agent file does not declare a spec-driven workflow",
    fix: "document the spec-driven workflow in AGENTS.md",
  };
}

// --- checks: configuration (5) ----------------------------------------------

function checkCfgLint(root: string): CheckResult {
  const config = hasPattern(root, [/^\.eslintrc/, /^eslint\.config\./, /^biome\.json/, /^\.golangci/, /^ruff\.toml/, /^\.markdownlint/]);
  const cmd = scriptKey(root, /lint/i) ?? (makefileTarget(root, "lint") ? "lint" : null);
  const ci = /\blint\b/i.test(ciContent(root));
  const ok = config !== null && (cmd !== null || ci);
  return {
    id: "cfg-lint",
    category: "configuration",
    score: ok ? 1 : 0,
    max: 1,
    evidence: config && (cmd ?? (ci ? "CI lint step" : "no command")) ? `${config} + ${cmd ?? "CI lint step"}` : `lint config: ${config ?? "missing"}, command: ${cmd ?? "missing"}`,
    fix: "transform Stage 2",
  };
}

function checkCfgFormat(root: string): CheckResult {
  const config = hasPattern(root, [/^\.prettierrc/, /^prettier\.config\./, /^biome\.json/, /^rustfmt\.toml/]);
  const cmd = scriptKey(root, /^format\b|^fmt\b/) ?? (makefileTarget(root, "format") ? "format" : null);
  const ok = config !== null && cmd !== null;
  return {
    id: "cfg-format",
    category: "configuration",
    score: ok ? 1 : 0,
    max: 1,
    evidence: ok ? `${config} + format command` : `formatter config: ${config ?? "missing"}, command: ${cmd ?? "missing"}`,
    fix: "transform Stage 2",
  };
}

function checkCfgHooks(root: string): CheckResult {
  const mechanism = hasPattern(root, [/^\.pre-commit-config\.ya?ml$/, /^lefthook\.ya?ml$/, /^\.husky$/, /^\.lintstagedrc/]);
  let discipline = false;
  if (mechanism) {
    const p = join(root, mechanism);
    if (lstatSync(p).isFile()) {
      discipline = /\bcommitlint\b|\bmarkdownlint\b/i.test(readIfExists(p) ?? "");
    } else {
      // directory mechanism (.husky): discipline requires a commitlint/markdownlint config
      discipline = hasPattern(root, [/^\.commitlintrc/, /^commitlint\.config/, /^\.markdownlint/]) !== null;
    }
  }
  // Gate-active check: config content alone proves nothing — the hooks
  // must actually be installed. pre-commit/lefthook write .git/hooks/;
  // husky keeps its hooks in .husky/ (core.hooksPath). A missing `.git`
  // (or a worktree `.git` file) means no installable hooks — under-score.
  const hooksActive = (() => {
    if (mechanism === ".husky") {
      return (
        existsSync(join(root, ".husky", "pre-commit")) ||
        existsSync(join(root, ".husky", "commit-msg"))
      );
    }
    const gitDir = join(root, ".git");
    if (!existsSync(gitDir) || !lstatSync(gitDir).isDirectory()) return false;
    return (
      existsSync(join(gitDir, "hooks", "pre-commit")) ||
      existsSync(join(gitDir, "hooks", "commit-msg"))
    );
  })();

  if (mechanism === null || !discipline) {
    return {
      id: "cfg-hooks",
      category: "configuration",
      score: 0,
      max: 1,
      evidence: `hook mechanism: ${mechanism ?? "missing"}${mechanism ? ", no commitlint/markdownlint found" : ""}`,
      fix: "transform Stage 2 (commitlint + pre-commit)",
    };
  }
  if (!hooksActive) {
    return {
      id: "cfg-hooks",
      category: "configuration",
      score: 0.5,
      max: 1,
      evidence: `${mechanism} config present but git hooks not installed — run: pre-commit install --hook-type commit-msg`,
      fix: "install the hooks: pre-commit install --hook-type commit-msg",
    };
  }
  return {
    id: "cfg-hooks",
    category: "configuration",
    score: 1,
    max: 1,
    evidence: `${mechanism} enforces commit discipline (git hooks installed)`,
    fix: "transform Stage 2 (commitlint + pre-commit)",
  };
}

function checkCfgCi(root: string): CheckResult {
  const content = ciContent(root);
  const hasLint = /\blint\b/i.test(content);
  const hasTest = /\btest\b/i.test(content);
  const ok = content.length > 0 && hasLint && hasTest;
  return {
    id: "cfg-ci",
    category: "configuration",
    score: ok ? 1 : 0,
    max: 1,
    evidence: content.length === 0 ? "no CI config found" : `CI present (lint: ${hasLint}, test: ${hasTest})`,
    fix: "transform Stage 2 (CI lint + test jobs)",
  };
}

function checkCfgTest(root: string): CheckResult {
  const cmd = scriptKey(root, /^test\b|^spec\b/) ?? (makefileTarget(root, "test") ? "test" : null);
  const config = hasPattern(root, [/^vitest\.config/, /^jest\.config/, /^playwright\.config/, /^pytest\.ini/, /^conftest\.py/]);
  const ok = cmd !== null || config !== null;
  return {
    id: "cfg-test",
    category: "configuration",
    score: ok ? 1 : 0,
    max: 1,
    evidence: ok ? `test: ${cmd ?? config}` : "no test framework or test command found",
    fix: "transform Stage 2 (add a test command)",
  };
}

// --- checks: integrity (4) ---------------------------------------------------

function checkSecEnv(root: string): CheckResult {
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) {
    return { id: "sec-env", category: "integrity", score: 1, max: 1, evidence: "no .env file present", fix: "keep secrets out of the repo" };
  }
  if (gitOk(root, ["ls-files", "--error-unmatch", ".env"])) {
    return { id: "sec-env", category: "integrity", score: 0, max: 1, evidence: ".env is tracked by git", fix: "remove .env from history and ignore it" };
  }
  if (gitOk(root, ["check-ignore", "-q", ".env"])) {
    return { id: "sec-env", category: "integrity", score: 1, max: 1, evidence: ".env present but ignored via .gitignore", fix: "none" };
  }
  return { id: "sec-env", category: "integrity", score: 0, max: 1, evidence: ".env present but not ignored", fix: "add .env to .gitignore" };
}

function checkSecScan(root: string): CheckResult {
  const gitleaksConfig = existsSync(join(root, ".gitleaks.toml"));
  const mentioned =
    /\bgitleaks\b/i.test(readIfExists(join(root, ".pre-commit-config.yaml")) ?? "") ||
    /\bgitleaks\b/i.test(ciContent(root));
  const ok = gitleaksConfig || mentioned;
  return {
    id: "sec-scan",
    category: "integrity",
    score: ok ? 1 : 0,
    max: 1,
    evidence: ok ? "secret scanning configured (gitleaks)" : "no secret scanning configured",
    fix: "transform Stage 2 (gitleaks)",
  };
}

function checkSecCi(root: string): CheckResult {
  const ok = /\bgitleaks\b|\btrivy\b|\bsnyk\b|\bcodeql\b|\bsecurity\b/i.test(ciContent(root));
  return {
    id: "sec-ci",
    category: "integrity",
    score: ok ? 1 : 0,
    max: 1,
    evidence: ok ? "CI contains a security job" : "CI has no security job",
    fix: "transform Stage 2 (CI security job)",
  };
}

function checkDrift(root: string): CheckResult {
  const exists = existsSync(join(root, ".ai-native.yml"));
  return {
    id: "drift",
    category: "integrity",
    score: exists ? 1 : 0,
    max: 1,
    evidence: exists ? ".ai-native.yml present (full consistency check lives in the check command, M2)" : ".ai-native.yml manifest missing",
    fix: "run transform to install the manifest",
  };
}

// --- checks: freshness (3) ---------------------------------------------------

function checkFreshRecent(root: string): CheckResult {
  const ts = lastCommitTs(root);
  if (ts === null) {
    return { id: "fresh-recent", category: "freshness", score: 0, max: 1, evidence: "no git history", fix: "n/a" };
  }
  const days = daysSince(ts);
  return {
    id: "fresh-recent",
    category: "freshness",
    score: days <= 90 ? 1 : days <= 180 ? 0.5 : 0,
    max: 1,
    evidence: `last commit ${Math.floor(days)} days ago`,
    fix: "n/a",
  };
}

function checkFreshActive(root: string): CheckResult {
  const ts = lastCommitTs(root);
  if (ts === null) {
    return { id: "fresh-active", category: "freshness", score: 0, max: 1, evidence: "no git history", fix: "n/a" };
  }
  const days = daysSince(ts);
  return {
    id: "fresh-active",
    category: "freshness",
    score: days <= 30 ? 1 : days <= 90 ? 0.5 : 0,
    max: 1,
    evidence: `last commit ${Math.floor(days)} days ago`,
    fix: "n/a",
  };
}

function checkFreshDeps(root: string): CheckResult {
  const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "uv.lock", "poetry.lock", "pdm.lock"];
  const lock = lockfiles.find((f) => existsSync(join(root, f)));
  const pkg = packageJson(root);
  const pyproject = existsSync(join(root, "pyproject.toml"));

  if (pkg) {
    const deps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    const wildcard = Object.values(deps).some((v) => String(v).includes("*"));
    const pinned = !wildcard;
    const score = pinned && lock ? 1 : pinned ? 0.5 : 0;
    const evidence = lock ? `deps pinned + ${lock}` : pinned ? "deps pinned, no lockfile" : "deps use wildcard ranges";
    return { id: "fresh-deps", category: "freshness", score, max: 1, evidence, fix: "pin versions and commit a lockfile" };
  }
  if (pyproject) {
    const score = lock ? 1 : 0.5;
    return { id: "fresh-deps", category: "freshness", score, max: 1, evidence: lock ? `pyproject.toml + ${lock}` : "pyproject.toml, no lockfile", fix: "commit a lockfile" };
  }
  return { id: "fresh-deps", category: "freshness", score: 0, max: 1, evidence: "no dependency manifest", fix: "n/a" };
}

// --- checks: structure (2) ----------------------------------------------------

function checkStructReadme(root: string): CheckResult {
  const readme = ["README.md", "README"]
    .map((f) => join(root, f))
    .find((f) => existsSync(f) && lstatSync(f).isFile());
  const content = readme ? readIfExists(readme) ?? "" : "";
  const ok = content.trim().length > 50;
  return {
    id: "struct-readme",
    category: "structure",
    score: ok ? 1 : 0,
    max: 1,
    evidence: ok ? `${readme}: ${content.trim().length} chars` : `README: ${readme ? "too short (<50 chars)" : "missing"}`,
    fix: "write a real README",
  };
}

function checkStructLayout(root: string): CheckResult {
  const organized = ["src", "lib", "packages"].some((d) => {
    const p = join(root, d);
    return existsSync(p) && lstatSync(p).isDirectory();
  });
  return {
    id: "struct-layout",
    category: "structure",
    score: organized ? 1 : 0,
    max: 1,
    evidence: organized ? "sources organized under src/ lib/ packages/" : "no src/, lib/, or packages/ directory",
    fix: "organize sources under src/, lib/, or packages/",
  };
}

// --- maturity + assembly -------------------------------------------------------

function assessMaturity(root: string, hasBuildCmd: boolean, hasAgent: boolean, hasCi: boolean): { maturity: AuditResult["maturity"]; note: string | null } {
  const commits = git(root, ["rev-list", "--count", "HEAD"]);
  const count = commits ? Number.parseInt(commits, 10) : 0;
  if (count < 5) {
    return { maturity: "skeleton", note: "Fewer than 5 commits — too early to transform. Return once the project stabilizes." };
  }
  if (hasBuildCmd) {
    return { maturity: "stable", note: null };
  }
  if (!hasAgent && !hasCi) {
    return { maturity: "legacy", note: "Established repo without agent files or CI — Stage 2 conservative mode recommended." };
  }
  return { maturity: "stable", note: null };
}

/** Full audit pipeline — exported for reuse by check.ts (M3). */
export function runAudit(root: string): AuditResult {
  const items: CheckResult[] = [
    checkAgentsMd(root),
    checkAgentsBridge(root),
    checkAgentsLength(root),
    checkAgentsCommands(root),
    checkAgentsSdd(root),
    checkCfgLint(root),
    checkCfgFormat(root),
    checkCfgHooks(root),
    checkCfgCi(root),
    checkCfgTest(root),
    checkSecEnv(root),
    checkSecScan(root),
    checkSecCi(root),
    checkDrift(root),
    checkFreshRecent(root),
    checkFreshActive(root),
    checkFreshDeps(root),
    checkStructReadme(root),
    checkStructLayout(root),
  ];

  const byCategory = Object.fromEntries(
    CATEGORY_ORDER.map((category) => [
      category,
      {
        score: items.filter((i) => i.category === category).reduce((sum, i) => sum + i.score, 0),
        max: CATEGORY_MAX[category],
      },
    ]),
  ) as Record<Category, { score: number; max: number }>;

  const total = CATEGORY_ORDER.reduce((sum, c) => sum + byCategory[c].score, 0);
  const gaps = items.filter((i) => i.score < i.max).map((i) => i.id);
  const suggestions = CATEGORY_ORDER.filter((c) => items.some((i) => i.category === c && i.score < i.max)).map(
    (c) => SUGGESTIONS[c],
  );

  const stacks = detect(root).stacks;
  const hasBuildCmd =
    scriptKey(root, /^(build|compile|typecheck|check|verify)\b/) !== null || makefileTarget(root, "build");
  const { maturity, note } = assessMaturity(root, hasBuildCmd, agentFile(root) !== null, hasCi(root));

  return {
    schemaVersion: 1,
    root: ".",
    stacks,
    maturity,
    maturityNote: note,
    score: { total, max: SCORE_MAX, byCategory },
    items,
    gaps,
    suggestions,
  };
}

// --- rendering -----------------------------------------------------------------

function renderMarkdown(r: AuditResult): string {
  const lines: string[] = [];
  lines.push("# AI-Readiness Report", "");
  lines.push(
    `- Stack: ${r.stacks.join(", ") || "unknown"} · Maturity: ${r.maturity} · Score: **${r.score.total}/${r.score.max}**`,
    "",
  );
  if (r.maturityNote) lines.push(`> ${r.maturityNote}`, "");

  lines.push("## Score by category", "");
  lines.push("| Category | Score | Max |", "|---|---|---|");
  for (const c of CATEGORY_ORDER) {
    lines.push(`| ${CATEGORY_LABELS[c]} | ${r.score.byCategory[c].score} | ${r.score.byCategory[c].max} |`);
  }
  lines.push("");

  lines.push("## Gaps", "");
  const gapItems = r.items.filter((i) => i.score < i.max);
  if (gapItems.length === 0) {
    lines.push("None — fully ready.", "");
  } else {
    lines.push("| Check | Score | Evidence | Fix |", "|---|---|---|---|");
    for (const i of gapItems) {
      lines.push(`| ${i.id} | ${i.score}/${i.max} | ${i.evidence} | ${i.fix} |`);
    }
    lines.push("");
  }

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
    major > 24 ||
    (major === 24 && minor >= 12) ||
    (major === 23 && minor >= 6) ||
    (major === 22 && minor >= 18);
  if (!ok) {
    console.error(
      `audit: Node.js >= 22.18 required (native type stripping); found ${process.versions.node}.\n` +
        "Upgrade Node, e.g. via your version manager (nvm install --lts).",
    );
    process.exit(1);
  }
}

// CLI entry: runs only when executed directly (importing must not trigger side effects)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  assertNodeVersion();
  const { root, format } = parseArgs(process.argv.slice(2));
  try {
    const result = runAudit(root);
    process.stdout.write(format === "markdown" ? renderMarkdown(result) : `${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    console.error(`audit: failed to scan ${root}: ${(err as Error).message}`);
    process.exit(1);
  }
}
