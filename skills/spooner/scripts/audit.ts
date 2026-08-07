#!/usr/bin/env node
/**
 * audit — Spooner M1 slices 2-3 + M13: AI-Readiness scoring engine.
 *
 * Scores a repository against the M13 quality matrix (10 points across 5
 * categories, 19 checks, 0.1 granularity — every score is max × a 0.2-step
 * coefficient), plus the maturity gating rules from the internal design
 * archive (local-only).
 *
 * Every check must be backed by real evidence (file paths, git state, or
 * commands traceable to manifests) — no invented facts. "Quality" means
 * deterministic signals only (command traceability, CI job depth, hook
 * installation state, manifest consistency) — never LLM judgment.
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
import { readManifest, TOOL_VERSION } from "./transform.ts";

/**
 * Full marks is 10 — but a 10 requires every one of the 17 checks to max out,
 * which the check design (existence + quality signals + per-stack attainable
 * ceilings) makes almost unreachable in practice, the same way pylint's
 * standard library scores 9.x, never 10. A 9.5 is the realistic "excellent"
 * benchmark (8 = good); scores near 10 are not artificially capped — they
 * just don't happen.
 */
const SCORE_MAX = 10;

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
  subStacks: { stack: string; dir: string }[];
  items: CheckResult[];
  gaps: string[];
  suggestions: string[];
}

const CATEGORY_ORDER: readonly Category[] = ["agent-setup", "configuration", "integrity", "freshness", "structure"];

/**
 * Category weights — the single adjustable knob for the score distribution
 * (2026-08-07 normalization layer, decoupled from the check structure: raw
 * check scores scale to these weights per category). Agent Setup is the
 * AI-specific core and carries the most weight; Configuration / Integrity are
 * generic devops practices (helpful to AI but not AI-specific) and are
 * deliberately weighted lower; Freshness holds deps-locking only — code
 * activity is not scored (a dormant repo is not worse than an active one).
 */
const CATEGORY_WEIGHTS: Record<Category, number> = {
  "agent-setup": 4.5,
  configuration: 2,
  integrity: 1.5,
  freshness: 0.5,
  structure: 1.5,
};

const CATEGORY_LABELS: Record<Category, string> = {
  "agent-setup": "Agent Setup",
  configuration: "Configuration",
  integrity: "Integrity",
  freshness: "Freshness",
  structure: "Structure",
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
  return typeof scripts === "object" && scripts !== null ? (scripts as Record<string, string>) : {};
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

/**
 * Per-stack lifecycle command presence (decision #13 + spec 0011): standard
 * commands traced to build files — go.mod → go build/test, python → python3 -m
 * unittest, java → mvn/gradle, Cargo.toml → cargo build/test. The CI hard gate
 * verifies them (same trust model as package.json scripts).
 */
function stackCommandSources(root: string): { hasBuild: boolean; hasTest: boolean; source: string | null } {
  const stacks = detect(root).stacks;
  if (stacks.includes("go")) return { hasBuild: true, hasTest: true, source: "go.mod (go build/test)" };
  if (stacks.includes("rust")) return { hasBuild: true, hasTest: true, source: "Cargo.toml (cargo build/test)" };
  if (stacks.includes("python"))
    return { hasBuild: false, hasTest: true, source: "pyproject.toml (python3 -m unittest)" };
  if (stacks.includes("java")) {
    if (existsSync(join(root, "build.gradle")))
      return { hasBuild: true, hasTest: true, source: "build.gradle (gradle build/test)" };
    return { hasBuild: true, hasTest: true, source: "pom.xml (mvn compile/test)" };
  }
  return { hasBuild: false, hasTest: false, source: null };
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
  for (const file of [".gitlab-ci.yml", ".circleci/config.yml", ".travis.yml", "Jenkinsfile", "azure-pipelines.yml"]) {
    parts.push(readIfExists(join(root, file)) ?? "");
  }
  // Filter empties: missing CI files must not inflate hasCi (joining
  // empty strings still yields newlines → length > 0 → false positive)
  return parts.filter((p) => p.length > 0).join("\n");
}

function hasCi(root: string): boolean {
  return ciContent(root).length > 0;
}

// --- monorepo sub-stack note (M13) -----------------------------------------

/** Known manifests per stack — mirrors detect.ts, applied to subdirectories. */
const SUBSTACK_MANIFESTS: readonly [string, string][] = [
  ["node", "package.json"],
  ["python", "pyproject.toml"],
  ["python", "requirements.txt"],
  ["go", "go.mod"],
  ["rust", "Cargo.toml"],
  ["java", "pom.xml"],
  ["java", "build.gradle"],
  ["ruby", "Gemfile"],
  ["php", "composer.json"],
  ["swift", "Package.swift"],
];

/** Vendored/build/tooling dirs that must never count as sub-stacks. */
const VENDORED_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  ".git",
  ".idea",
  ".vscode",
  ".claude",
  ".github",
  "coverage",
  "dist",
  "build",
  ".output",
  ".next",
  ".wxt",
  ".playwright-mcp",
  ".ruff_cache",
  ".pytest_cache",
  "__pycache__",
]);

/** Bounded one-level sub-stack scan (M13): known manifests in direct child dirs. */
function subStacksOf(root: string): { stack: string; dir: string }[] {
  const out: { stack: string; dir: string }[] = [];
  for (const entry of (entriesOf(root) ?? []).sort()) {
    const p = join(root, entry);
    if (!existsSync(p) || !lstatSync(p).isDirectory()) continue;
    if (entry.startsWith(".") || VENDORED_DIRS.has(entry)) continue;
    for (const [stack, manifest] of SUBSTACK_MANIFESTS) {
      if (existsSync(join(p, manifest))) {
        out.push({ stack, dir: entry });
        break;
      }
    }
    if (!out.some((s) => s.dir === entry) && (entriesOf(p) ?? []).some((f) => f.endsWith(".csproj"))) {
      out.push({ stack: "dotnet", dir: entry });
    }
  }
  return out;
}

// --- checks: agent-setup (3.0) ---------------------------------------------

function agentFile(root: string): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const p = join(root, name);
    if (existsSync(p) && (lstatSync(p).isFile() || lstatSync(p).isSymbolicLink())) return name;
  }
  return null;
}

/** Commands mentioned in a file that trace to real sources (scripts/Makefile/stack). */
function traceableCommandsOf(content: string, root: string): string[] {
  const found: string[] = [];
  const scripts = packageScripts(root);
  for (const m of content.matchAll(/`npm run ([a-z0-9:_-]+)`/g)) {
    if (scripts[m[1]]) found.push(`npm run ${m[1]}`);
  }
  const targets = makefileTargets(root);
  for (const m of content.matchAll(/`make ([a-z0-9_.-]+)`/g)) {
    if (targets.includes(m[1])) found.push(`make ${m[1]}`);
  }
  const sc = stackCommandSources(root);
  if (sc.source !== null && /\b(go|cargo|mvn|gradle|python3 -m unittest)\b/.test(content)) {
    found.push(sc.source);
  }
  return [...new Set(found)];
}

function checkAgentsMd(root: string): CheckResult {
  const file = agentFile(root);
  if (!file) {
    return {
      id: "agents-md",
      category: "agent-setup",
      score: 0,
      max: 0.5,
      evidence: "agent file: missing",
      fix: "transform Stage 3",
    };
  }
  const content = readIfExists(join(root, file)) ?? "";
  const lines = content.split("\n").length;
  const traceable = traceableCommandsOf(content, root);
  let score = 0.2;
  let detail = `${file}: ${lines} lines, no command section`;
  if (traceable.length >= 2) {
    score = 0.5;
    detail = `${file}: ${lines} lines, ${traceable.length} traceable commands`;
  } else if (traceable.length === 1) {
    score = 0.4;
    detail = `${file}: ${lines} lines, 1 command traceable`;
  } else if (/\bcommands\b|`npm run|`make |\| Command \|/i.test(content)) {
    score = 0.3;
    detail = `${file}: ${lines} lines with a command section`;
  }
  return {
    id: "agents-md",
    category: "agent-setup",
    score,
    max: 0.5,
    evidence: detail,
    fix: "keep commands in AGENTS.md traceable to real scripts/Makefile",
  };
}

function checkAgentsBridge(root: string): CheckResult {
  const claude = join(root, "CLAUDE.md");
  let detail = "CLAUDE.md: missing";
  let score = 0;
  if (existsSync(claude)) {
    const isLink = lstatSync(claude).isSymbolicLink();
    const isFile = lstatSync(claude).isFile();
    const content = isFile ? (readIfExists(claude) ?? "") : "";
    if (isLink) {
      detail = "CLAUDE.md: symlink to AGENTS.md";
      score = 0.5;
    } else if (/^\s*@AGENTS\.md\b/m.test(content)) {
      detail = "CLAUDE.md: @AGENTS.md import bridge";
      score = 0.5;
    } else if (/\bAGENTS\.md\b/i.test(content)) {
      detail = "CLAUDE.md: content reference to AGENTS.md only";
      score = 0.3;
    } else {
      detail = "CLAUDE.md: exists but no bridge to AGENTS.md";
    }
  }
  return { id: "agents-bridge", category: "agent-setup", score, max: 0.5, evidence: detail, fix: "transform Stage 3" };
}

function checkAgentsLength(root: string): CheckResult {
  const file = agentFile(root);
  if (!file) {
    return {
      id: "agents-length",
      category: "agent-setup",
      score: 0,
      max: 0.5,
      evidence: "no agent file",
      fix: "transform Stage 3",
    };
  }
  const content = readIfExists(join(root, file)) ?? "";
  const lines = content.split("\n").length;
  const bytes = Buffer.byteLength(content, "utf8");
  let score: number;
  let detail: string;
  if (bytes > 40_000) {
    score = 0.1;
    detail = `${file}: ${bytes} chars exceeds the 40K hard block`;
  } else if (lines >= 30 && lines <= 200) {
    score = 0.5;
    detail = `${file}: ${lines} lines (optimal band 30-200)`;
  } else if ((lines >= 20 && lines < 30) || (lines > 200 && lines <= 300)) {
    score = 0.3;
    detail = `${file}: ${lines} lines (short or slightly over)`;
  } else if ((lines >= 10 && lines < 20) || (lines > 300 && lines <= 400)) {
    score = 0.2;
    detail = `${file}: ${lines} lines (thin or over)`;
  } else {
    score = 0.1;
    detail = `${file}: ${lines} lines (too thin or too long)`;
  }
  return {
    id: "agents-length",
    category: "agent-setup",
    score,
    max: 0.5,
    evidence: detail,
    fix: "trim AGENTS.md to ≤200 lines — merge content, don't delete it",
  };
}

function checkAgentsCommands(root: string): CheckResult {
  const buildKey = scriptKey(root, /^(build|compile|typecheck|check|verify)\b/);
  const testKey = scriptKey(root, /^(test|spec)\b/);
  const sc = stackCommandSources(root);
  const hasBuild = buildKey !== null || makefileTarget(root, "build") || sc.hasBuild;
  const hasTest = testKey !== null || makefileTarget(root, "test") || sc.hasTest;
  const hasThird =
    scriptKey(root, /^lint\b|^vet\b/) !== null || makefileTarget(root, "lint") || makefileTarget(root, "vet");
  const sources: string[] = [];
  if (buildKey || testKey) sources.push("package.json scripts");
  if (makefileTargets(root).length > 0) sources.push("Makefile");
  if (sc.source) sources.push(sc.source);
  const evidence =
    sources.length > 0
      ? `commands traceable to ${sources.join(" + ")} (build: ${hasBuild}, test: ${hasTest})`
      : "no build/test commands found in package.json, Makefile, or stack build files";

  // AGENTS.md documentation of the real commands (the 1.0 band).
  const agentContent = agentFile(root) ? (readIfExists(join(root, agentFile(root)!)) ?? "") : "";
  const documented = traceableCommandsOf(agentContent, root).length >= 2;

  let score: number;
  if (!hasBuild && !hasTest) {
    score = /\bnpm (run )?(build|test)\b|`make (build|test)`|`(go|cargo|mvn|gradle) (build|test)`/.test(agentContent)
      ? 0.2
      : 0;
  } else if (hasBuild !== hasTest) {
    score = 0.4;
  } else if (!hasThird) {
    score = 0.6;
  } else if (!documented) {
    score = 0.8;
  } else {
    score = 1;
  }
  return {
    id: "agents-commands",
    category: "agent-setup",
    score,
    max: 1,
    evidence,
    fix: "add real build/test commands, then document them in AGENTS.md",
  };
}

/** Markdown files one level deep (specs/ contains numbered spec subdirs). */
function specFilesOf(dir: string): string[] {
  const out: string[] = [];
  for (const f of entriesOf(dir) ?? []) {
    const p = join(dir, f);
    if (lstatSync(p).isDirectory()) {
      for (const g of entriesOf(p) ?? []) if (g.endsWith(".md")) out.push(join(p, g));
    } else if (f.endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

function checkAgentsSdd(root: string): CheckResult {
  const file = agentFile(root);
  const content = file ? (readIfExists(join(root, file)) ?? "") : "";
  const mentions = /\bspec\b|spec-driven|\bSDD\b(?!-)/i.test(content);
  const specDir = existsSync(join(root, "specs"))
    ? join(root, "specs")
    : existsSync(join(root, "docs", "sdd"))
      ? join(root, "docs", "sdd")
      : null;
  const specFiles = specDir ? specFilesOf(specDir) : [];
  const hasState = specFiles.some((f) =>
    /^status:\s*(proposed|approved|in-progress|shipped)/m.test(readIfExists(f) ?? ""),
  );
  const hasCiGate = /\bspec\b|\bsdd\b/i.test(ciContent(root));
  let score = 0;
  let detail = "agent file does not declare a spec-driven workflow";
  if (mentions) {
    score = 0.2;
    detail = "agent file declares a spec-driven workflow";
  }
  if (mentions && specDir) {
    score = 0.3;
    detail = "agent file declares the workflow + spec files exist";
  }
  if (mentions && specDir && hasState) {
    score = 0.4;
    detail = "agent file declares the workflow + spec files carry state frontmatter";
  }
  if (mentions && specDir && hasState && hasCiGate) {
    score = 0.5;
    detail = "agent file declares the workflow + state-frontmatter specs + a CI spec gate";
  }
  return {
    id: "agents-sdd",
    category: "agent-setup",
    score,
    max: 0.5,
    evidence: detail,
    fix: "document the spec-driven workflow in AGENTS.md",
  };
}

// --- checks: configuration (2.5) -------------------------------------------

function checkCfgLint(root: string): CheckResult {
  const config = hasPattern(root, [
    /^\.eslintrc/,
    /^eslint\.config\./,
    /^biome\.json/,
    /^\.golangci/,
    /^ruff\.toml/,
    /^\.markdownlint/,
  ]);
  const cmd = scriptKey(root, /lint/i) ?? (makefileTarget(root, "lint") ? "lint" : null);
  const ci = /\blint\b/i.test(ciContent(root));
  let score = 0;
  if (config && cmd && ci) score = 0.5;
  else if (config && (cmd || ci)) score = 0.4;
  else if (config || cmd || ci) score = 0.2;
  const fix = config
    ? cmd
      ? "transform Stage 2 (CI lint job)"
      : "add a lint command (transform never invents commands)"
    : "add a lint config + command (eslint/biome/ruff)";
  return {
    id: "cfg-lint",
    category: "configuration",
    score,
    max: 0.5,
    evidence:
      config && (cmd ?? (ci ? "CI lint step" : "no command"))
        ? `${config} + ${cmd ?? "CI lint step"}`
        : `lint config: ${config ?? "missing"}, command: ${cmd ?? "missing"}`,
    fix,
  };
}

function checkCfgFormat(root: string): CheckResult {
  const config = hasPattern(root, [/^\.prettierrc/, /^prettier\.config\./, /^biome\.json/, /^rustfmt\.toml/]);
  const cmd = scriptKey(root, /^format\b|^fmt\b/) ?? (makefileTarget(root, "format") ? "format" : null);
  // Tool names only — the word "format" alone is noise (git log --format=%B
  // would false-positive on commitlint steps).
  const ci = /\b(prettier|black|gofmt|rustfmt|dprint)\b/i.test(ciContent(root));
  let score = 0;
  if (config && cmd && ci) score = 0.5;
  else if (config && (cmd || ci)) score = 0.4;
  else if (config || cmd || ci) score = 0.2;
  const fix = config
    ? cmd
      ? "transform Stage 2 (CI format job)"
      : "add a format command (transform never invents commands)"
    : "add a formatter config + format command (prettier/biome)";
  return {
    id: "cfg-format",
    category: "configuration",
    score,
    max: 0.5,
    evidence:
      config && (cmd ?? (ci ? "CI format step" : "no command"))
        ? `${config} + ${cmd ?? "CI format step"}`
        : `formatter config: ${config ?? "missing"}, command: ${cmd ?? "missing"}`,
    fix,
  };
}

function checkCfgHooks(root: string): CheckResult {
  const mechanism = hasPattern(root, [
    /^\.pre-commit-config\.ya?ml$/,
    /^lefthook\.ya?ml$/,
    /^\.husky$/,
    /^\.lintstagedrc/,
  ]);
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
  // Gate-active check (M7): config content alone proves nothing — the hooks
  // must actually be installed. pre-commit/lefthook write .git/hooks/;
  // husky keeps its hooks in .husky/ (core.hooksPath). A missing `.git`
  // (or a worktree `.git` file) means no installable hooks — under-score.
  const hooksActive = (() => {
    if (mechanism === ".husky") {
      return existsSync(join(root, ".husky", "pre-commit")) || existsSync(join(root, ".husky", "commit-msg"));
    }
    const gitDir = join(root, ".git");
    if (!existsSync(gitDir) || !lstatSync(gitDir).isDirectory()) return false;
    return existsSync(join(gitDir, "hooks", "pre-commit")) || existsSync(join(gitDir, "hooks", "commit-msg"));
  })();
  const commitMsgActive =
    mechanism === ".husky"
      ? existsSync(join(root, ".husky", "commit-msg"))
      : existsSync(join(root, ".git", "hooks", "commit-msg"));

  let score = 0;
  let detail = `hook mechanism: ${mechanism ?? "missing"}`;
  let fix = "transform Stage 2 (commitlint + pre-commit)";
  if (mechanism !== null && !discipline) {
    score = 0.1;
    detail = `${mechanism} present but no commitlint/markdownlint discipline`;
    fix = "add a commitlint/markdownlint config";
  } else if (mechanism !== null && discipline && !hooksActive) {
    score = 0.2;
    detail = `${mechanism} config present but git hooks not installed`;
    fix = "install the hooks: pre-commit install --hook-type pre-commit --hook-type commit-msg";
  } else if (mechanism !== null && discipline && hooksActive && !commitMsgActive) {
    score = 0.4;
    detail = `${mechanism} enforces commit discipline (hooks installed, commit-msg stage missing)`;
    fix = "install the commit-msg stage: pre-commit install --hook-type commit-msg";
  } else if (mechanism !== null && discipline && hooksActive && commitMsgActive) {
    score = 0.5;
    detail = `${mechanism} enforces commit discipline (hooks installed incl. commit-msg)`;
  }
  return { id: "cfg-hooks", category: "configuration", score, max: 0.5, evidence: detail, fix };
}

function checkCfgCi(root: string): CheckResult {
  const content = ciContent(root);
  const hasLint = /\blint\b/i.test(content);
  const hasTest = /\btest\b/i.test(content);
  const hasSec =
    /\b(gitleaks|trivy|snyk|codeql)\b/i.test(content) || /^\s{0,2}(security|gitleaks|scan)[a-z0-9_-]*:/m.test(content);
  let score = 0;
  if (content.length === 0) score = 0;
  else if (!hasLint && !hasTest) score = 0.1;
  else if (hasLint && !hasTest) score = 0.2;
  else if (hasLint && hasTest && !hasSec) score = 0.4;
  else score = 0.5;
  const fix =
    content.length === 0
      ? "transform Stage 2 (installs a CI workflow)"
      : !hasTest
        ? "add a test job (transform never invents commands — add a test script first)"
        : "transform Stage 2 (CI security job)";
  return {
    id: "cfg-ci",
    category: "configuration",
    score,
    max: 0.5,
    evidence:
      content.length === 0
        ? "no CI config found"
        : `CI present (lint: ${hasLint}, test: ${hasTest}, security: ${hasSec})`,
    fix,
  };
}

function checkCfgTest(root: string): CheckResult {
  const cmd = scriptKey(root, /^test\b|^spec\b/) ?? (makefileTarget(root, "test") ? "test" : null);
  const config = hasPattern(root, [
    /^vitest\.config/,
    /^jest\.config/,
    /^playwright\.config/,
    /^pytest\.ini/,
    /^conftest\.py/,
  ]);
  const testFiles = findTestFiles(root);
  const nonEmpty = testFiles.some((f) =>
    /\b(it|test|describe|assert|expect)\(|self\.assert|@Test|it\s*\(|test\s*\(/i.test(readIfExists(f) ?? ""),
  );
  let score = 0;
  if (cmd || config) score = cmd && config ? 0.3 : 0.2;
  if ((cmd || config) && testFiles.length > 0) score = 0.4;
  if (nonEmpty) score = 0.5;
  return {
    id: "cfg-test",
    category: "configuration",
    score,
    max: 0.5,
    evidence: nonEmpty
      ? `test: ${cmd ?? config} + ${testFiles.length} test file(s) with assertions`
      : (cmd ?? config)
        ? `test: ${cmd ?? config}`
        : testFiles.length > 0
          ? `${testFiles.length} test file(s), no test command`
          : "no test framework or test command found",
    fix: "add a test framework + test script (transform never invents commands)",
  };
}

/** Bounded test-file scan: known test dirs (one level) + root-level test files
 *  + test dirs inside one-level subdirs (monorepo-style, e.g. skills/spooner/test). */
function findTestFiles(root: string): string[] {
  const out: string[] = [];
  const collect = (dir: string) => {
    for (const f of entriesOf(dir) ?? []) {
      if (/\.(test|spec)\./i.test(f) || /^(test_|.*_test\.|.*_spec\.)/.test(f) || /\.(ts|js|mjs|py|go|rb|rs)$/.test(f))
        out.push(join(dir, f));
    }
  };
  for (const dir of ["test", "tests", "spec"]) {
    const p = join(root, dir);
    if (existsSync(p) && lstatSync(p).isDirectory()) collect(p);
  }
  for (const f of entriesOf(root) ?? []) {
    if (/\.(test|spec)\./i.test(f) || /^test_.*\.(py|js|ts)$/.test(f) || /.*_test\.(go|rs|rb)$/.test(f))
      out.push(join(root, f));
  }
  for (const entry of (entriesOf(root) ?? []).sort()) {
    const p = join(root, entry);
    if (!existsSync(p) || !lstatSync(p).isDirectory()) continue;
    if (entry.startsWith(".") || VENDORED_DIRS.has(entry)) continue;
    for (const dir of ["test", "tests", "spec"]) {
      const q = join(p, dir);
      if (existsSync(q) && lstatSync(q).isDirectory()) collect(q);
    }
    // two-level nesting (e.g. skills/spooner/test) — bounded, vendored dirs skipped
    for (const e2 of entriesOf(p) ?? []) {
      if (e2.startsWith(".") || VENDORED_DIRS.has(e2)) continue;
      for (const dir of ["test", "tests", "spec"]) {
        const q = join(p, e2, dir);
        if (existsSync(q) && lstatSync(q).isDirectory()) collect(q);
      }
    }
  }
  return out;
}

// --- checks: integrity (2.0) ------------------------------------------------

function checkSecEnv(root: string): CheckResult {
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) {
    return {
      id: "sec-env",
      category: "integrity",
      score: 0.5,
      max: 0.5,
      evidence: "no .env file present",
      fix: "keep secrets out of the repo",
    };
  }
  if (gitOk(root, ["ls-files", "--error-unmatch", ".env"])) {
    return {
      id: "sec-env",
      category: "integrity",
      score: 0,
      max: 0.5,
      evidence: ".env is tracked by git",
      fix: "remove .env from history and ignore it",
    };
  }
  if (gitOk(root, ["check-ignore", "-q", ".env"])) {
    return {
      id: "sec-env",
      category: "integrity",
      score: 0.5,
      max: 0.5,
      evidence: ".env present but ignored via .gitignore",
      fix: "none",
    };
  }
  return {
    id: "sec-env",
    category: "integrity",
    score: 0.1,
    max: 0.5,
    evidence: ".env present but not ignored",
    fix: "add .env to .gitignore",
  };
}

function checkSecScan(root: string): CheckResult {
  const gitleaksConfig = existsSync(join(root, ".gitleaks.toml"));
  const preCommit = readIfExists(join(root, ".pre-commit-config.yaml")) ?? "";
  const mentioned = gitleaksConfig || /\bgitleaks\b/i.test(preCommit) || /\bgitleaks\b/i.test(ciContent(root));
  const declared = /\bgitleaks\b/i.test(preCommit);
  const installed =
    existsSync(join(root, ".git", "hooks", "pre-commit")) || existsSync(join(root, ".husky", "pre-commit"));
  let score = 0;
  let detail = "no secret scanning configured";
  if (mentioned) {
    score = 0.2;
    detail = "secret scanning mentioned (gitleaks)";
  }
  if (declared) {
    score = 0.3;
    detail = "gitleaks declared as a pre-commit hook";
  }
  if (declared && installed) {
    score = 0.5;
    detail = "gitleaks hook declared and installed (actually runs)";
  }
  return {
    id: "sec-scan",
    category: "integrity",
    score,
    max: 0.5,
    evidence: detail,
    fix: "transform Stage 2 (gitleaks)",
  };
}

function checkSecCi(root: string): CheckResult {
  const content = ciContent(root);
  // Job names at GitHub (2-space indent) or GitLab (0-space top-level) depth —
  // step names sit at deeper indents and don't match.
  const job = /^\s{0,2}(security|gitleaks|scan)[a-z0-9_-]*:/m.test(content);
  const mentioned = /\b(gitleaks|trivy|snyk|codeql)\b/i.test(content);
  let score = 0;
  let detail = "CI has no security job";
  if (mentioned && !job) {
    score = 0.2;
    detail = "CI mentions a security tool, no dedicated job";
  } else if (job) {
    score = 0.5;
    detail = "CI contains a dedicated security job";
  }
  return {
    id: "sec-ci",
    category: "integrity",
    score,
    max: 0.5,
    evidence: detail,
    fix: "transform Stage 2 (CI security job)",
  };
}

/** Which transform stage restores a manifest-listed file (mirrors check.ts). */
function stageHintOf(missing: string[]): number {
  if (missing.some((f) => f.startsWith("docs/sdd") || f.endsWith("sdd.yml"))) return 4;
  if (missing.some((f) => f === "AGENTS.md" || f === "CLAUDE.md")) return 3;
  return 2;
}

function checkDrift(root: string): CheckResult {
  const { present, manifest } = readManifest(root);
  if (!present) {
    return {
      id: "drift",
      category: "integrity",
      score: 0,
      max: 0.5,
      evidence: ".ai-native.yml manifest missing",
      fix: "run transform to install the manifest",
    };
  }
  const version = typeof manifest?.version === "string" ? manifest.version : "0.0.0";
  const current = version === TOOL_VERSION;
  const declared = Object.values(manifest?.stages ?? {}).flatMap((s) =>
    s && Array.isArray(s.files) ? (s.files as string[]) : [],
  );
  const missingFiles = declared.filter((f) => !existsSync(join(root, f)));
  const allPresent = missingFiles.length === 0;
  let score = 0.2;
  let detail = `.ai-native.yml present (v${version})`;
  if (current) {
    score = 0.3;
    detail = `.ai-native.yml present at v${version} == tool v${TOOL_VERSION}`;
  }
  if (current && allPresent) {
    score = 0.5;
    detail = `.ai-native.yml consistent (v${version}, ${declared.length} declared file(s) present)`;
  }
  // Version current but files missing → the fix names the restore stage
  // (review 2026-08-06: it used to say "none" — misleading at 0.3).
  const fix = !current
    ? "run sync to apply the current templates"
    : allPresent
      ? "none"
      : `re-run transform stage ${stageHintOf(missingFiles)} to restore missing files`;
  return { id: "drift", category: "integrity", score, max: 0.5, evidence: detail, fix };
}

// --- checks: freshness (1.5) -------------------------------------------------

function checkFreshDeps(root: string): CheckResult {
  const lockfiles = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "uv.lock",
    "poetry.lock",
    "pdm.lock",
  ];
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
    const score = pinned && lock ? 0.5 : pinned ? 0.3 : 0.1;
    const evidence = lock ? `deps pinned + ${lock}` : pinned ? "deps pinned, no lockfile" : "deps use wildcard ranges";
    return {
      id: "fresh-deps",
      category: "freshness",
      score,
      max: 0.5,
      evidence,
      fix: "pin versions and commit a lockfile",
    };
  }
  if (pyproject) {
    const score = lock ? 0.5 : 0.2;
    return {
      id: "fresh-deps",
      category: "freshness",
      score,
      max: 0.5,
      evidence: lock ? `pyproject.toml + ${lock}` : "pyproject.toml, no lockfile",
      fix: "commit a lockfile",
    };
  }
  // go/rust: the checksum lockfiles are the lockfile signal (review 2026-08-06
  // — these stacks scored 0 forever with the misleading "no dependency manifest").
  if (existsSync(join(root, "go.mod"))) {
    const sum = existsSync(join(root, "go.sum"));
    return {
      id: "fresh-deps",
      category: "freshness",
      score: sum ? 0.5 : 0.2,
      max: 0.5,
      evidence: sum ? "go.mod + go.sum (checksum lockfile)" : "go.mod, no go.sum committed",
      fix: "commit go.sum (module checksums)",
    };
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    const cargoLock = existsSync(join(root, "Cargo.lock"));
    return {
      id: "fresh-deps",
      category: "freshness",
      score: cargoLock ? 0.5 : 0.3,
      max: 0.5,
      evidence: cargoLock
        ? "Cargo.toml + Cargo.lock (pinned + lockfile)"
        : "Cargo.toml declares versions, no Cargo.lock",
      fix: "commit Cargo.lock for reproducible builds",
    };
  }
  // java pins versions in the manifest itself — no lockfile convention.
  if (existsSync(join(root, "pom.xml")) || existsSync(join(root, "build.gradle"))) {
    return {
      id: "fresh-deps",
      category: "freshness",
      score: 0.3,
      max: 0.5,
      evidence: "java manifest pins dependency versions (no lockfile convention)",
      fix: "n/a",
    };
  }
  return {
    id: "fresh-deps",
    category: "freshness",
    score: 0,
    max: 0.5,
    evidence: "no dependency manifest",
    fix: "n/a",
  };
}

// --- checks: structure (1.0) --------------------------------------------------

function checkStructReadme(root: string): CheckResult {
  const readme = ["README.md", "README"].map((f) => join(root, f)).find((f) => existsSync(f) && lstatSync(f).isFile());
  const content = readme ? (readIfExists(readme) ?? "") : "";
  const chars = content.trim().length;
  const headings = content.match(/^#{2,3}\s+/gm)?.length ?? 0;
  let score = 0;
  let detail = `README: ${readme ? "too short (<50 chars)" : "missing"}`;
  if (readme && chars > 50 && headings >= 3) {
    score = 0.5;
    detail = `${readme}: ${chars} chars with ${headings} section headings`;
  } else if (readme && chars > 50) {
    score = 0.3;
    detail = `${readme}: ${chars} chars, no section headings`;
  } else if (readme) {
    score = 0.1;
  }
  return {
    id: "struct-readme",
    category: "structure",
    score,
    max: 0.5,
    evidence: detail,
    fix: "write a real README with sections",
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
    score: organized ? 0.5 : 0,
    max: 0.5,
    evidence: organized ? "sources organized under src/ lib/ packages/" : "no src/, lib/, or packages/ directory",
    fix: "organize sources under src/, lib/, or packages/ (not covered by transform)",
  };
}

// --- maturity + assembly -------------------------------------------------------

function assessMaturity(
  root: string,
  hasBuildCmd: boolean,
  hasAgent: boolean,
  hasCi: boolean,
): { maturity: AuditResult["maturity"]; note: string | null } {
  const commits = git(root, ["rev-list", "--count", "HEAD"]);
  const count = commits ? Number.parseInt(commits, 10) : 0;
  if (count < 5) {
    return {
      maturity: "skeleton",
      note: "Fewer than 5 commits — too early to transform. Return once the project stabilizes.",
    };
  }
  if (hasBuildCmd) {
    return { maturity: "stable", note: null };
  }
  if (!hasAgent && !hasCi) {
    return {
      maturity: "legacy",
      note: "Established repo without agent files or CI — Stage 2 conservative mode recommended.",
    };
  }
  return { maturity: "stable", note: null };
}

/** Round to the display granularity (0.1) — float accumulation must never
 *  leak tails like 1.4000000000000001 into a report (M13 report truth). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Full audit pipeline — exported for reuse by check.ts (M3) / badge.ts (M9). */
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
    checkFreshDeps(root),
    checkStructReadme(root),
    checkStructLayout(root),
  ];

  // Normalization layer (2026-08-07, decoupled): each category's raw check
  // scores scale from the check maxima to the category weight — the weights
  // table is the single knob, the check structure stays untouched. Full marks
  // = 10 (every check maxed); 9.5 is the excellent benchmark, not a cap.
  const byCategory = Object.fromEntries(
    CATEGORY_ORDER.map((category) => {
      const checks = items.filter((i) => i.category === category);
      const checkSum = checks.reduce((s, i) => s + i.max, 0);
      const raw = checks.reduce((s, i) => s + i.score, 0);
      return [
        category,
        {
          score: round1(checkSum > 0 ? (raw * CATEGORY_WEIGHTS[category]) / checkSum : 0),
          max: CATEGORY_WEIGHTS[category],
        },
      ];
    }),
  ) as Record<Category, { score: number; max: number }>;

  const total = round1(CATEGORY_ORDER.reduce((sum, c) => sum + byCategory[c].score, 0));
  const gaps = items.filter((i) => i.score < i.max).map((i) => i.id);
  // Suggestions (M13): per category with below-max checks, the missing
  // checks' fixes deduped — fully-scoring categories stay silent.
  const suggestions = CATEGORY_ORDER.filter((c) => items.some((i) => i.category === c && i.score < i.max)).map((c) => {
    const fixes = [...new Set(items.filter((i) => i.category === c && i.score < i.max).map((i) => i.fix))];
    return `${CATEGORY_LABELS[c]}: ${fixes.join("; ")}`;
  });

  const stacks = detect(root).stacks;
  const subStacks = subStacksOf(root);
  const hasBuildCmd =
    scriptKey(root, /^(build|compile|typecheck|check|verify)\b/) !== null || makefileTarget(root, "build");
  const { maturity, note } = assessMaturity(root, hasBuildCmd, agentFile(root) !== null, hasCi(root));

  return {
    schemaVersion: 3,
    root,
    stacks,
    maturity,
    maturityNote: note,
    score: { total, max: SCORE_MAX, byCategory },
    subStacks,
    items,
    gaps,
    suggestions,
  };
}

// --- rendering -----------------------------------------------------------------

/** Human-readable audit report — exported for reuse by badge.ts (M9). */
export function renderMarkdown(r: AuditResult): string {
  const lines: string[] = [];
  lines.push("# AI-Readiness Report", "");
  lines.push(
    `- Stack: ${r.stacks.join(", ") || "unknown"} · Maturity: ${r.maturity} · Score: **${r.score.total.toFixed(1)}/${r.score.max}**`,
    "",
  );
  if (r.maturityNote) lines.push(`> ${r.maturityNote}`, "");
  if (r.subStacks.length > 0) {
    lines.push(
      `- Sub-stacks: ${r.subStacks.map((s) => `${s.stack} (${s.dir}/)`).join(", ")} — root detection only; transform installs the root stack's gates; run transform per sub-stack`,
      "",
    );
  }

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
    major > 24 || (major === 24 && minor >= 12) || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
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
