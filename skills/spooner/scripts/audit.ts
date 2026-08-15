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
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { isDirectEntry } from "./entry.ts";
import { detect, PYTHON_FILES } from "./detect.ts";
import { lifecycleOf } from "./stacks.ts";
import { classifyFailure, readManifest, TOOL_VERSION, verifyCommandsOf } from "./transform.ts";

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
 * (normalization layer, decoupled from the check structure: raw
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
  return (
    mk
      .split("\n")
      // Real targets only: a leading alpha excludes make special targets
      // (.PHONY …) and `:(?!=)` excludes variable assignments (VAR := …) —
      // both otherwise surface as phantom commands in the command table
      // (`make PROJECT_NAME` / `make .PHONY` would violate the
      // "never invent commands" killer gate).
      .filter((line) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\s*:(?!=)/.test(line))
      .map((line) => line.split(":")[0].trim())
  );
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
 * verifies them (same trust model as package.json scripts). The lint signal is
 * the stack's canonical vet/lint gate — go vet / cargo clippy (a Go repo
 * with no Makefile would cap agents-commands at 0.6 forever, though the
 * generated pre-commit config runs go vet).
 */
function stackCommandSources(root: string): {
  hasBuild: boolean;
  hasTest: boolean;
  hasLint: boolean;
  source: string | null;
} {
  const stacks = detect(root).stacks;
  if (stacks.includes("go")) {
    const lc = lifecycleOf("go");
    return { hasBuild: lc.build, hasTest: lc.test, hasLint: lc.lint, source: "go.mod (go build/test)" };
  }
  if (stacks.includes("rust")) {
    const lc = lifecycleOf("rust");
    return { hasBuild: lc.build, hasTest: lc.test, hasLint: lc.lint, source: "Cargo.toml (cargo build/test)" };
  }
  if (stacks.includes("python")) {
    // Evidence must name a file that exists: resolve against the detect
    // signals in order (regression — a requirements.txt-only repo was
    // credited with a non-existent pyproject.toml; setup.py joined the signal
    // set, so the resolver must too).
    // Unreachable fallback: stacks.includes("python") implies one signal exists.
    const manifest = PYTHON_FILES.find((f) => existsSync(join(root, f))) ?? "pyproject.toml";
    // hasLint follows the generated ruff gate — the stack's canonical lint
    // (a Python repo whose ruff hook ran but whose branch had no lint signal
    // would cap agents-commands at the test-only band).
    return {
      hasBuild: false,
      hasTest: true,
      hasLint: generatedRuffGate(root)?.lint ?? false,
      source: `${manifest} (python3 -m unittest)`,
    };
  }
  if (stacks.includes("java")) {
    if (
      ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].some((f) =>
        existsSync(join(root, f)),
      )
    )
      return { hasBuild: true, hasTest: true, hasLint: false, source: "build.gradle (gradle build/test)" };
    return { hasBuild: true, hasTest: true, hasLint: false, source: "pom.xml (mvn compile/test)" };
  }
  // php: no standard build command; the test signal is phpunit (config or
  // require-dev declaration). Note: this branch fires for php-only repos —
  // mixed repos resolve the primary stack first (node etc.), and agents-commands
  // adds the php signal separately.
  if (stacks.includes("php")) {
    const phpunit = existsSync(join(root, "phpunit.xml")) || existsSync(join(root, "phpunit.xml.dist"));
    return {
      hasBuild: false,
      hasTest: phpunit,
      hasLint: false,
      source: phpunit ? "phpunit.xml (phpunit)" : (phpTestFrameworkOf(root) ?? "composer.json (no test framework)"),
    };
  }
  // A group (spec 0014): detected but transform-unsupported —
  // the audit credits their canonical lifecycle where one exists. Branch
  // order is the implicit priority (php's pattern: appended after php, before
  // the fallback). Evidence names the actually-present signal file — never
  // hard-code a manifest that may not exist (the python pyproject/requirements
  // precedent). unity has no canonical lifecycle command (documented ceiling).
  if (stacks.includes("apple")) {
    // Evidence must name a real file — the actual top-level apple entry, never
    // a glob literal (spec 0001 "evidence names files that actually exist";
    // the xcworkspace-only fallback must not emit the literal "*.xcodeproj").
    // readdirSync order is FS-dependent — pick deterministically
    // (lexicographically smallest) for cross-platform determinism.
    const topLevel = (entriesOf(root) ?? []).sort();
    const appleEntry =
      topLevel.find((f) => f.endsWith(".xcodeproj")) ?? topLevel.find((f) => f.endsWith(".xcworkspace"));
    const manifest = existsSync(join(root, "Podfile"))
      ? "Podfile"
      : existsSync(join(root, "Project.swift"))
        ? "Project.swift"
        : existsSync(join(root, "Cartfile"))
          ? "Cartfile"
          : (appleEntry ?? "xcode project");
    const lc = lifecycleOf("apple");
    return { hasBuild: lc.build, hasTest: lc.test, hasLint: lc.lint, source: `${manifest} (xcodebuild build/test)` };
  }
  if (stacks.includes("dart/flutter")) {
    // test-only band (like python): flutter test is the canonical test
    // command; dart has no standard build concept. hasLint mirrors
    // stackLintCommandOf — `dart analyze` is the official static analysis
    // (dart.dev) and counts as the stack's canonical lint. Booleans derive
    // from the shared STACK_COMMANDS table (spec 0015 slice 2).
    const lc = lifecycleOf("dart/flutter");
    return { hasBuild: lc.build, hasTest: lc.test, hasLint: lc.lint, source: "pubspec.yaml (flutter test)" };
  }
  // zig: canonical lifecycle (ziglang.org build system — zig build /
  // zig build test are unambiguous). The rest of the spec-0014 Tier-2 list
  // is deferred until the skill has real adoption;
  // clojure/haskell etc. would stay uncredited anyway (split toolchains —
  // honest under-scoring).
  if (stacks.includes("zig")) {
    const lc = lifecycleOf("zig");
    return { hasBuild: lc.build, hasTest: lc.test, hasLint: lc.lint, source: "build.zig (zig build / zig build test)" };
  }
  if (stacks.includes("c/cpp")) {
    const manifest = existsSync(join(root, "CMakeLists.txt"))
      ? "CMakeLists.txt"
      : existsSync(join(root, "meson.build"))
        ? "meson.build"
        : existsSync(join(root, "vcpkg.json"))
          ? "vcpkg.json"
          : "conanfile.txt";
    const lc = lifecycleOf("c/cpp");
    return { hasBuild: lc.build, hasTest: lc.test, hasLint: lc.lint, source: `${manifest} (cmake --build / ctest)` };
  }
  return { hasBuild: false, hasTest: false, hasLint: false, source: null };
}

/** Stack-canonical lint command — go vet / cargo clippy are the lint gates
 *  the generated pre-commit config runs (M10), so a stack repo with the gate
 *  installed has a traceable lint command even without a Makefile (a
 *  Makefile-less Go repo with .golangci.yaml + CI lint step but no command
 *  would score cfg-lint only 0.4). */
function stackLintCommandOf(root: string): string | null {
  const stacks = detect(root).stacks;
  if (stacks.includes("go")) return "go vet ./...";
  if (stacks.includes("rust")) return "cargo clippy";
  if (stacks.includes("python") && generatedRuffGate(root)?.lint) return "ruff check";
  // dart/flutter's canonical static analysis (dart.dev: `dart analyze` is the
  // official linter for both Dart and Flutter projects — spec 0014 D group).
  if (stacks.includes("dart/flutter")) return "dart analyze";
  return null;
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

/** Known manifests per stack — mirrors detect.ts, applied to subdirectories.
 *  Exact-match representatives only (spec 0014): glob signals
 *  (*.xcodeproj / *.cabal / *.rockspec) do not participate in the bounded
 *  sub-stack scan. */
const SUBSTACK_MANIFESTS: readonly [string, string][] = [
  ["node", "package.json"],
  // Single-sourced from detect's python signals (hardening) —
  // the "mirrors detect.ts" comment below stays true only while this holds.
  ...PYTHON_FILES.map((file) => ["python", file] as [string, string]),
  ["go", "go.mod"],
  ["rust", "Cargo.toml"],
  ["java", "pom.xml"],
  ["java", "build.gradle"],
  ["java", "build.gradle.kts"],
  ["ruby", "Gemfile"],
  ["php", "composer.json"],
  ["swift", "Package.swift"],
  ["apple", "Podfile"],
  ["c/cpp", "CMakeLists.txt"],
  ["dart/flutter", "pubspec.yaml"],
  ["unity", "ProjectSettings/ProjectVersion.txt"],
  ["zig", "build.zig"],
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

/** Root-level agent instruction files by ecosystem (official docs):
 *  AGENTS.md is the open standard (agents.md —
 *  Codex/Jules/Cursor/Copilot/Devin/Kilo/Augment/Windsurf/Cline read it
 *  natively, Qwen reads it too; AGENT.md is the standard's backward-compat
 *  variant); the rest are agent-specific primaries — QWEN.md (Qwen Code),
 *  CLAUDE.md (Claude Code — does NOT read AGENTS.md natively), GEMINI.md
 *  (Gemini CLI — needs config to read AGENTS.md), .github/copilot-instructions.md
 *  (Copilot), .cursorrules (Cursor legacy), .windsurfrules (Windsurf legacy),
 *  CONVENTIONS.md (Aider default), .clinerules (Cline). Directory rule sets
 *  (.cursor/rules/, .windsurf/rules/, .amazonq/rules/…) are scoped rules, not
 *  the agent contract — out of scope (roadmap candidate). */
const AGENT_FILES = [
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "QWEN.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
  ".windsurfrules",
  "CONVENTIONS.md",
  ".clinerules",
] as const;

/** Agent contract files at the root AND one directory level down (spec 0016
 *  revision): a layered hierarchy — agents/AGENTS.md next to the root
 *  contract, or a per-subproject contract — is the same artifact in layered
 *  form. Vendored/built dirs never count; paths in the enumeration
 *  (.github/copilot-instructions.md) stay root-only. */
const AGENT_DIR_EXCLUDES = [
  "node_modules",
  ".venv",
  ".git",
  "dist",
  "build",
  "coverage",
  ".ai-native",
  "vendor", // go/php vendored deps
  ".yarn",
];
function agentFiles(root: string): string[] {
  const found: string[] = [];
  const present = (p: string): boolean => {
    try {
      const st = lstatSync(p);
      return st.isFile() || st.isSymbolicLink();
    } catch {
      return false;
    }
  };
  for (const name of AGENT_FILES) if (present(join(root, name))) found.push(name);
  const subdirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !AGENT_DIR_EXCLUDES.includes(d.name))
    .map((d) => d.name)
    .sort();
  for (const dir of subdirs) {
    for (const name of AGENT_FILES) {
      if (name.includes("/")) continue;
      if (present(join(root, dir, name))) found.push(`${dir}/${name}`);
    }
  }
  return found;
}

/** The repo's primary agent contract — the most content-rich file (most
 *  traceable commands, then longest). No fixed priority: a Qwen-only repo
 *  (Alibaba-internal style — only Qwen Code / Qwen LLM) has QWEN.md as its
 *  primary; an AGENTS.md + thin QWEN.md repo keeps AGENTS.md (the open
 *  standard). Respect = score what the repo actually uses. */
function primaryAgentFile(root: string): string | null {
  const files = agentFiles(root);
  if (files.length === 0) return null;
  const ranked = files
    .map((f) => {
      const content = readIfExists(join(root, f)) ?? "";
      return { file: f, traceable: traceableCommandsOf(content, root).length, lines: content.split("\n").length };
    })
    .sort((a, b) => b.traceable - a.traceable || b.lines - a.lines);
  return ranked[0].file;
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
  // Per-stack lifecycle commands, each counted individually — a generated
  // AGENTS.md (go build/test/vet from go.mod) must get full traceability
  // credit, not one collapsed source string (a Makefile-less Go repo's
  // generated contract listing three commands must not score "1 traceable").
  const stackCmds: Record<string, RegExp[]> = {
    go: [/\bgo build\b/, /\bgo test\b/, /\bgo vet\b/],
    rust: [/\bcargo build\b/, /\bcargo test\b/, /\bcargo fmt --check\b/, /\bcargo clippy\b/],
    python: [/\bpython3 -m unittest\b/],
    java: [/\bmvn[^\n]*\btest\b/, /\bgradle build\b/],
    // A group (spec 0014): canonical lifecycle commands, traceable to the
    // stack's own manifest (detect + stackCommandSources).
    apple: [/\bxcodebuild test\b/, /\bxcodebuild build\b/],
    "c/cpp": [/\bcmake --build\b/, /\bctest\b/],
    "dart/flutter": [/\bflutter test\b/],
    zig: [/\bzig build test\b/, /\bzig build\b/],
  };
  for (const stack of detect(root).stacks) {
    for (const re of stackCmds[stack] ?? []) {
      const m = content.match(re);
      if (m) found.push(m[0]);
    }
  }
  return [...new Set(found)];
}

function checkAgentsMd(root: string): CheckResult {
  const file = primaryAgentFile(root);
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
  const files = agentFiles(root);
  if (files.length === 0) {
    return {
      id: "agents-bridge",
      category: "agent-setup",
      score: 0,
      max: 0.5,
      evidence: "agent file: missing",
      fix: "transform Stage 3",
    };
  }
  // A single agent contract is complete by itself — no bridge needed. The
  // old rule demanded CLAUDE.md → AGENTS.md links regardless of the repo's
  // ecosystem; a Qwen-only repo (Alibaba-internal style — Qwen Code + Qwen
  // LLM only) is fully served by QWEN.md alone.
  if (files.length === 1) {
    return {
      id: "agents-bridge",
      category: "agent-setup",
      score: 0.5,
      max: 0.5,
      evidence: `single agent file: ${files[0]} (no bridge needed)`,
      fix: "transform Stage 3",
    };
  }
  // Multiple contracts: check content unification between agent files in ANY
  // direction — a symlink or @import between any two files unifies them (a
  // reverse link like AGENTS.md → CLAUDE.md counts; the direction is not
  // sacred, only the unification is). The target match is
  // by realpath, not the literal readlink string: `CLAUDE.md → ./AGENTS.md`
  // (or ../AGENTS.md) is a common form and an exact-name compare would score
  // it as "no bridge" (a regression from the any-symlink 0.5). entry.ts
  // realpath precedent; broken links fall to catch.
  const content = (f: string) => readIfExists(join(root, f)) ?? "";
  const linkPairs = files.flatMap((f) => {
    const p = join(root, f);
    try {
      if (!lstatSync(p).isSymbolicLink()) return [];
      const targetReal = realpathSync(p);
      return files.filter((t) => t !== f && realpathSync(join(root, t)) === targetReal).map((t) => [f, t] as const);
    } catch {
      return [];
    }
  });
  if (linkPairs.length > 0) {
    const [from, to] = linkPairs[0];
    return {
      id: "agents-bridge",
      category: "agent-setup",
      score: 0.5,
      max: 0.5,
      evidence: `${from} symlinks to ${to} — agent files unified`,
      fix: "transform Stage 3",
    };
  }
  const importPairs = files.flatMap((f) =>
    files
      .filter((t) => t !== f && new RegExp(`^\\s*@${t.replace(/\./g, "\\.")}\\b`, "m").test(content(f)))
      .map((t) => [f, t] as const),
  );
  if (importPairs.length > 0) {
    const [from, to] = importPairs[0];
    return {
      id: "agents-bridge",
      category: "agent-setup",
      score: 0.5,
      max: 0.5,
      evidence: `${from} imports @${to} — agent files unified`,
      fix: "transform Stage 3",
    };
  }
  const refPairs = files.flatMap((f) =>
    files
      .filter((t) => t !== f && new RegExp(`\\b${t.replace(/\./g, "\\.")}\\b`, "i").test(content(f)))
      .map((t) => [f, t] as const),
  );
  if (refPairs.length > 0) {
    const [from, to] = refPairs[0];
    return {
      id: "agents-bridge",
      category: "agent-setup",
      score: 0.3,
      max: 0.5,
      evidence: `${from} references ${to} (content only)`,
      fix: "transform Stage 3",
    };
  }
  return {
    id: "agents-bridge",
    category: "agent-setup",
    score: 0,
    max: 0.5,
    evidence: `${files.join(", ")} coexist without any bridge — agents read different contracts`,
    fix: "transform Stage 3",
  };
}

function checkAgentsLength(root: string): CheckResult {
  const file = primaryAgentFile(root);
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

/**
 * Actually run the traced lifecycle commands (same command family as
 * transform's stage 2 — verifyCommandsOf is the one source of truth, spec
 * 0002: --verify-command override + monorepo degradation apply here too).
 * Returns null when all passed, or a note explaining why verification could
 * not pass. Static tracing only proves the commands exist, not that they
 * run — this is the audit-side counterpart of transform stage 2's build
 * verification; missing tools are not failing builds (the shared
 * classifyFailure reads the whole stderr — a `sh: pnpm: command not found`
 * inside an npm script names pnpm, not the script's first word).
 */
function verificationNote(root: string, verifyCommand?: string): string | null {
  const cmds = verifyCommandsOf(root, verifyCommand);
  if (cmds.length === 0) return "no local lifecycle command to verify";
  for (const cmd of cmds) {
    try {
      execFileSync("sh", ["-c", cmd], { cwd: root, stdio: "pipe" });
    } catch (err) {
      const e = (err ?? {}) as { status?: number; stderr?: Buffer | string };
      const stderr = String(e.stderr ?? "").trim();
      const c = classifyFailure(e.status ?? null, stderr, false);
      if (c.state === "unverifiable") {
        const tool = c.rawTool ?? cmd.split(/\s+/)[0];
        return `${tool} is not installed (exit 127) — install the tool and re-run`;
      }
      const excerpt = stderr.length > 120 ? `${stderr.slice(0, 120)}…` : stderr;
      return `${cmd} FAILED (exit ${e.status ?? "?"}${excerpt ? `: ${excerpt}` : ""})`;
    }
  }
  return null;
}

function checkAgentsCommands(root: string, verify = false, verifyCommand?: string): CheckResult {
  const buildKey = scriptKey(root, /^(build|compile|typecheck|check|verify)\b/);
  const testKey = scriptKey(root, /^(test|spec)\b/);
  const sc = stackCommandSources(root);
  // PHP signal beyond the primary stack — mixed node+php repos trace phpunit
  // even though primaryStack() resolves to node.
  const phpSource = sc.hasTest ? null : detect(root).stacks.includes("php") ? phpTestSourceOf(root) : null;
  // c/cpp second-stack build signal — a test-only primary (python/php/
  // dart-flutter) can sit on a build-carrying stack: python+c/cpp repos build
  // the C++ core with cmake, and that build concept is real (reporting
  // build: false would contradict the c/cpp branch's own cmake credit).
  // Same manifest probe as stackCommandSources' c/cpp branch —
  // evidence names the actually-present file (spec 0001). sc.source === null
  // = no primary lifecycle at all; sc.hasBuild = primary already carries a
  // build concept (node+apple stays node-only, spec 0014 acceptance 10b).
  const cppSource =
    sc.source !== null && !sc.hasBuild && detect(root).stacks.includes("c/cpp")
      ? `${
          existsSync(join(root, "CMakeLists.txt"))
            ? "CMakeLists.txt"
            : existsSync(join(root, "meson.build"))
              ? "meson.build"
              : existsSync(join(root, "vcpkg.json"))
                ? "vcpkg.json"
                : "conanfile.txt"
        } (cmake --build / ctest)`
      : null;
  // cppSource feeds hasBuild itself (not just the evidence string) — the
  // evidence may say "(build: true)" while the band logic reads an unmerged
  // hasBuild and scores 0 (asymmetry).
  const hasBuild = buildKey !== null || makefileTarget(root, "build") || sc.hasBuild || cppSource !== null;
  const hasTest = testKey !== null || makefileTarget(root, "test") || sc.hasTest || phpSource !== null;
  const hasThird =
    scriptKey(root, /^lint\b|^vet\b/) !== null ||
    makefileTarget(root, "lint") ||
    makefileTarget(root, "vet") ||
    sc.hasLint ||
    // Any detected stack's canonical lint gate (stackLintCommandOf: go vet /
    // cargo clippy / ruff check / dart analyze) — the first-matched branch of
    // stackCommandSources must not swallow another stack's real lint concept
    // (apple+dart/flutter repos lose dart analyze because the apple branch
    // fires first — an AGENTS.md documenting dart analyze would still score
    // 0.6 with "add a lint command").
    stackLintCommandOf(root) !== null;
  const sources: string[] = [];
  if (buildKey || testKey) sources.push("package.json scripts");
  if (makefileTargets(root).length > 0) sources.push("Makefile");
  if (sc.source) sources.push(sc.source);
  if (phpSource && !sources.includes(phpSource)) sources.push(phpSource);
  if (cppSource && !sources.includes(cppSource)) sources.push(cppSource);
  // Tracing is static — the score proves the commands exist in real files, not
  // that they run. --verify executes them (note null = all passed); otherwise
  // the evidence says so instead of implying verified behavior.
  const verifyNote = verify ? verificationNote(root, verifyCommand) : undefined;
  const evidence =
    sources.length > 0
      ? `commands traceable to ${sources.join(" + ")} (build: ${hasBuild}, test: ${hasTest})${
          verifyNote === undefined
            ? " — static trace, not executed (--verify runs them)"
            : verifyNote === null
              ? " — verified: lifecycle commands passed"
              : ` — ${verifyNote}`
        }`
      : "no build/test commands found in package.json, Makefile, or stack build files";

  // Primary agent contract documentation of the real commands (the 1.0 band).
  const agentContent = primaryAgentFile(root) ? (readIfExists(join(root, primaryAgentFile(root)!)) ?? "") : "";
  // Test-only stacks (python/php: no build concept) have a complete lifecycle
  // with the test command alone — the build side is not "missing", it does not
  // exist (a Python repo would cap at 0.4 forever because hasBuild: false
  // never leaves the asymmetric band).
  const testOnlyStack = sc.source !== null && !sc.hasBuild && sc.hasTest;
  // No-lint stacks (c/cpp, zig, apple): no canonical lint command exists in
  // the ecosystem (cmake/ctest, zig build, xcodebuild) — the third command is
  // not missing either (test-only band's mirror: c/cpp with a complete
  // build+test lifecycle must not cap at 0.6 forever). Only
  // when the repo's command sources are exclusively these stacks — a mixed
  // repo with node/python/go/rust/java/dart-flutter keeps a real lint
  // concept, so the gap is genuine there (node+apple scores like node-only,
  // spec 0014 acceptance 10b).
  const stacks = detect(root).stacks;
  const noLintStack =
    sc.source !== null &&
    !sc.hasLint &&
    stacks.some((s) => ["c/cpp", "zig", "apple"].includes(s)) &&
    // php carries a real lint concept (cfg-lint credits phpcs.xml / phpstan
    // .neon / psalm.xml, cfg-format credits php-cs-fixer) — php belongs in the
    // lint-capable list, or php+c/cpp repos would score the no-lint band 0.8
    // with zero traceable commands (contradicting the "the gap is genuine"
    // principle).
    !stacks.some((s) => ["node", "python", "go", "rust", "java", "dart/flutter", "php"].includes(s));
  // The 1.0 band requires the commands documented in AGENTS.md — for test-only
  // stacks the single test command IS the lifecycle (python cannot produce two
  // traceable commands; the ≥2 rule would cap it at 0.8).
  const documented = traceableCommandsOf(agentContent, root).length >= (testOnlyStack ? 1 : 2);

  let score: number;
  if (!hasBuild && !hasTest) {
    score = /\bnpm (run )?(build|test)\b|`make (build|test)`|`(go|cargo|mvn|gradle) (build|test)`/.test(agentContent)
      ? 0.2
      : 0;
  } else if (!testOnlyStack && hasBuild !== hasTest) {
    score = 0.4;
  } else if (!hasThird && !noLintStack) {
    score = 0.6;
  } else if (!documented) {
    score = 0.8;
  } else {
    score = 1;
  }
  // Fix copy per band — never say "add" when the commands already exist
  // (a fix suggesting commands that are traceable AND already documented in
  // the generated AGENTS.md).
  const fix =
    !hasBuild && !hasTest
      ? "add real build/test commands, then document them in AGENTS.md"
      : !testOnlyStack && hasBuild !== hasTest
        ? "add the missing build/test command, then document it in AGENTS.md"
        : !hasThird && !noLintStack
          ? "add a lint command (the stack's canonical lint gate), then document the commands in AGENTS.md"
          : "document the traced commands in AGENTS.md";
  return {
    id: "agents-commands",
    category: "agent-setup",
    score,
    max: 1,
    evidence,
    fix,
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
  const file = primaryAgentFile(root);
  const content = file ? (readIfExists(join(root, file)) ?? "") : "";
  const mentions = /\bspec\b|spec-driven|\bSDD\b(?!-)/i.test(content);
  // The repo's own plan/spec/notes hierarchy counts too (spec 0013 revision):
  // a `.agents/notes` tree is the same discipline in a different form — the
  // 0.3/0.4/0.5 bands grade it identically to specs/ or docs/sdd/.
  const specDir = existsSync(join(root, "specs"))
    ? join(root, "specs")
    : existsSync(join(root, "docs", "sdd"))
      ? join(root, "docs", "sdd")
      : existsSync(join(root, ".agents", "notes"))
        ? join(root, ".agents", "notes")
        : null;
  const specFiles = specDir ? specFilesOf(specDir) : [];
  const hasState = specFiles.some((f) =>
    /^status:\s*(proposed|approved|in-progress|shipped)/m.test(readIfExists(f) ?? ""),
  );
  const hasCiGate = /\bspec\b|\bsdd\b/i.test(ciContent(root));
  const dirLabel = specDir ? specDir.replace(join(root, "") + "/", "") : null; // specs / docs/sdd / .agents/notes
  let score = 0;
  let detail = "agent file does not declare a spec-driven workflow";
  if (mentions) {
    score = 0.2;
    detail = "agent file declares a spec-driven workflow";
  }
  if (mentions && specDir) {
    score = 0.3;
    detail = `agent file declares the workflow + spec files exist (${dirLabel})`;
  }
  if (mentions && specDir && hasState) {
    score = 0.4;
    detail = `agent file declares the workflow + spec files carry state frontmatter (${dirLabel})`;
  }
  if (mentions && specDir && hasState && hasCiGate) {
    score = 0.5;
    detail = `agent file declares the workflow + state-frontmatter specs + a CI spec gate (${dirLabel})`;
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
  const ruff = generatedRuffGate(root);
  const config =
    hasPattern(root, [
      /^\.eslintrc/,
      /^eslint\.config\./,
      /^biome\.json/,
      /^\.golangci/,
      /^\.oxlintrc/, // oxlint (`.oxlintrc*.json`) — same signal class as the ruff round
      /^ruff\.toml/,
      /^\.markdownlint/,
      /^phpcs\.xml/,
      /^phpstan\.neon/,
      /^psalm\.xml/,
      /^analysis_options\.yaml$/,
    ]) ??
    ktlintConfigOf(root) ??
    (ruff?.lint ? ruff.label : null);
  const cmd = scriptKey(root, /lint/i) ?? (makefileTarget(root, "lint") ? "lint" : null) ?? stackLintCommandOf(root);
  const ci = /\blint\b/i.test(ciContent(root));
  let score = 0;
  if (config && cmd && ci) score = 0.5;
  else if (config && (cmd || ci)) score = 0.4;
  else if (config || cmd || ci) score = 0.2;
  const fix = config
    ? cmd
      ? "transform Stage 2 (CI lint job)"
      : "add a lint command (transform never invents commands)"
    : "add a lint config + command (eslint/biome/ruff/oxlint)";
  return {
    id: "cfg-lint",
    category: "configuration",
    score,
    max: 0.5,
    evidence:
      config && (cmd ?? (ci ? "CI lint step" : "no command"))
        ? `${config} + ${cmd ?? (ci ? "CI lint step" : "no command")}`
        : `lint config: ${config ?? "missing"}, command: ${cmd ?? "missing"}`,
    fix,
  };
}

/** ktlint config signal (kotlin): ktlint.toml, or the .editorconfig `ktlint_*`
 *  keys (ktlint's standard configuration — kotlin/Android). */
function ktlintConfigOf(root: string): string | null {
  if (existsSync(join(root, "ktlint.toml"))) return "ktlint.toml";
  if (/ktlint_/i.test(readIfExists(join(root, ".editorconfig")) ?? "")) return ".editorconfig (ktlint)";
  return null;
}

/** The generated pre-commit config runs gofmt for go stacks (M10 gate) — a
 *  formatter gate the audit's own stage 2 installs must be credited, or the
 *  audit contradicts its own product (a Makefile-less Go repo with the gofmt
 *  hook installed and passing would score cfg-format 0.2). Repo-owned gofmt
 *  hooks are credited too, but only tool-owned configs are labeled
 *  "generated" (a mislabel contradicts the report's own evidence). */
function generatedGofmtGate(root: string): { config: string; cmd: string } | null {
  if (!detect(root).stacks.includes("go")) return null;
  const pc = readIfExists(join(root, ".pre-commit-config.yaml"));
  if (!pc) return null;
  const m = pc.match(/\bentry: (gofmt[^\n]*)/);
  if (!m) return null;
  const toolOwned = pc.includes(GENERATED_PRE_COMMIT_MARKER);
  return { config: toolOwned ? "gofmt (generated pre-commit gate)" : "gofmt (pre-commit hook)", cmd: m[1].trim() };
}

/** Tool-owned marker of the generated pre-commit config (spec 0012; must stay
 *  in sync with transform.ts's GENERATED_PRE_COMMIT_MARKER). */
const GENERATED_PRE_COMMIT_MARKER = "# pre-commit config generated by spooner transform Stage 2";

/** The generated pre-commit config runs ruff / ruff-format for python stacks
 *  (M10 gate) — the python mirror of the gofmt gate: installed and running
 *  gates must be credited, or the audit contradicts its own product (a
 *  Python repo whose ruff hooks ran and blocked 7 files while cfg-format
 *  reported 0/0.5). A repo-owned ruff config is credited the same way (a
 *  running hook is a running hook) but only tool-owned configs are labeled
 *  "generated" (a repo's own pre-commit config must not be mislabeled as a
 *  spooner product). */
function generatedRuffGate(
  root: string,
): { lint: boolean; format: boolean; label: string; formatLabel: string } | null {
  if (!detect(root).stacks.includes("python")) return null;
  const pc = readIfExists(join(root, ".pre-commit-config.yaml"));
  if (!pc || !/\bid: ruff\b/.test(pc)) return null;
  const toolOwned = pc.includes(GENERATED_PRE_COMMIT_MARKER);
  const suffix = toolOwned ? "generated pre-commit gate" : "pre-commit hook";
  return {
    lint: true,
    format: /\bid: ruff-format\b/.test(pc),
    label: `ruff (${suffix})`,
    formatLabel: `ruff-format (${suffix})`,
  };
}

function checkCfgFormat(root: string): CheckResult {
  // ruff provides both lint and format — a ruff.toml counts as a formatter
  // config exactly as it counts as a lint config (symmetry); php-cs-fixer is
  // the php formatter config; ktlint is the kotlin linter + formatter (lint
  // and format both count its config).
  const gate = generatedGofmtGate(root);
  const ruff = generatedRuffGate(root);
  const config =
    hasPattern(root, [
      /^\.prettierrc/,
      /^prettier\.config\./,
      /^biome\.json/,
      /^rustfmt\.toml/,
      /^ruff\.toml/,
      /^\.php-cs-fixer/,
      /^\.clang-format/,
      /^\.swiftformat/,
    ]) ??
    ktlintConfigOf(root) ??
    gate?.config ??
    (ruff?.format ? ruff.formatLabel : null);
  const cmd =
    scriptKey(root, /^format\b|^fmt\b/) ??
    (makefileTarget(root, "format") ? "format" : null) ??
    gate?.cmd ??
    (ruff?.format ? "ruff format" : null);
  // Tool names only — the word "format" alone is noise (git log --format=%B
  // would false-positive on commitlint steps). A group (spec 0014 D group):
  // swiftformat / clang-format / cmake-format joined the whitelist.
  const ci = /\b(prettier|black|gofmt|rustfmt|dprint|ruff|swiftformat|clang-format|cmake-format)\b/i.test(
    ciContent(root),
  );
  let score = 0;
  if (config && cmd && ci) score = 0.5;
  else if (config && (cmd || ci)) score = 0.4;
  else if (config || cmd || ci) score = 0.2;
  const fix = config
    ? cmd
      ? "transform Stage 2 (CI format job)"
      : "add a format command (transform never invents commands)"
    : "add a formatter config + format command (prettier/biome/ruff)";
  return {
    id: "cfg-format",
    category: "configuration",
    score,
    max: 0.5,
    evidence:
      config && (cmd ?? (ci ? "CI format step" : "no command"))
        ? `${config} + ${cmd ?? (ci ? "CI format step" : "no command")}`
        : `formatter config: ${config ?? "missing"}, command: ${cmd ?? "missing"}`,
    fix,
  };
}

/** package.json-field hook mechanisms — husky v4 / yorkie (vue-cli default)
 *  configure their hooks in package.json, not in a directory. */
function pkgHookFieldOf(root: string): string | null {
  const pkg = packageJson(root);
  if (!pkg) return null;
  const v = (name: string): unknown => (pkg as Record<string, unknown>)[name];
  // yorkie reads the legacy `gitHooks` field too (vue-cli 2/3 schema)
  if (v("yorkie") !== undefined && (typeof v("yorkie") === "object" || typeof v("gitHooks") === "object"))
    return "yorkie (package.json)";
  if (v("husky") !== undefined && typeof v("husky") === "object") return "husky (package.json)";
  return null;
}

function checkCfgHooks(root: string): CheckResult {
  // Host mechanisms first (pre-commit config / lefthook / .husky), then
  // package.json fields (yorkie / husky v4 — the actual hook installers),
  // then lint-staged's config last: .lintstagedrc is NOT a hook mechanism,
  // it runs via a host hook — a yorkie repo with .lintstagedrc must be
  // recognized as yorkie.
  const mechanism =
    hasPattern(root, [/^\.pre-commit-config\.ya?ml$/, /^lefthook\.ya?ml$/, /^\.husky$/]) ??
    pkgHookFieldOf(root) ??
    hasPattern(root, [/^\.lintstagedrc/]);
  let discipline = false;
  if (mechanism) {
    const disciplineConfig = hasPattern(root, [/^\.commitlintrc/, /^commitlint\.config/, /^\.markdownlint/]) !== null;
    if (mechanism.endsWith("(package.json)")) {
      // field mechanisms (husky v4 / yorkie): the field names lint-staged etc.,
      // the commit discipline lives in the separate commitlint/markdownlint
      // config — a .commitlintrc beside a .lintstagedrc must not falsely report
      // "no commitlint discipline" because only the mechanism file was read
      discipline = disciplineConfig;
    } else {
      const p = join(root, mechanism);
      if (lstatSync(p).isFile()) {
        discipline = /\bcommitlint\b|\bmarkdownlint\b/i.test(readIfExists(p) ?? "") || disciplineConfig;
      } else {
        // directory mechanism (.husky): discipline requires a commitlint/markdownlint config
        discipline = disciplineConfig;
      }
    }
  }
  // Hook files must actually REFER to the mechanism's tool — existence alone
  // proves nothing (a yorkie-installed .git/hooks/pre-commit would be counted
  // as pre-commit's own hook; dead/stale hook scripts as active).
  // The pre-commit pattern is the generated hook's own marker — a bare
  // "pre-commit" word is NOT enough (yorkie/husky runner scripts pass the
  // hook name as an argument: "node …/yorkie/bin/runner.js pre-commit").
  const PRE_COMMIT_HOOK = /generated by pre-commit|pre-commit run|pre-commit\.com/i;
  const TOOL_OF: Record<string, RegExp> = {
    ".pre-commit-config.yaml": PRE_COMMIT_HOOK,
    "lefthook.yml": /\blefthook\b/i,
    ".lintstagedrc": /\b(yorkie|husky|lefthook)\b|generated by pre-commit/i, // runs via a host hook
    "yorkie (package.json)": /\byorkie\b/i,
    "husky (package.json)": /\bhusky\b/i,
  };
  // lefthook installs its wrappers into `git config core.hooksPath` when set
  // (lefthook's recommended layout) — .git/hooks/ alone would misjudge an
  // installed lefthook repo as "not installed" (spec 0013 revision).
  // --local only: a GLOBAL core.hooksPath (a common dotfiles setting) must
  // not be read as this repo's hook state (review round, 2026-08-16). The
  // dir is resolved once — hookRefersTool runs twice (pre-commit/commit-msg).
  const hooksDir = (() => {
    try {
      const p = execFileSync("git", ["-C", root, "config", "--local", "--get", "core.hooksPath"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      return p ? resolve(root, p) : null;
    } catch {
      return null;
    }
  })();
  const hookRefersTool = (name: string): boolean => {
    const p = join(hooksDir ?? join(root, ".git", "hooks"), name);
    if (!existsSync(p) || !lstatSync(p).isFile()) return false;
    const tool = mechanism ? TOOL_OF[mechanism] : null;
    return tool ? tool.test(readIfExists(p) ?? "") : true;
  };
  // Gate-active check (M7): config content alone proves nothing — the hooks
  // must actually be installed. pre-commit/lefthook write .git/hooks/
  // (lefthook honors core.hooksPath); husky keeps its hooks in .husky/
  // (core.hooksPath). A missing `.git` (or a worktree `.git` file) means no
  // installable hooks — under-score.
  const hooksActive = (() => {
    if (mechanism === ".husky") {
      return existsSync(join(root, ".husky", "pre-commit")) || existsSync(join(root, ".husky", "commit-msg"));
    }
    const gitDir = join(root, ".git");
    if (!existsSync(gitDir) || !lstatSync(gitDir).isDirectory()) return false;
    return hookRefersTool("pre-commit") || hookRefersTool("commit-msg");
  })();
  const commitMsgActive =
    mechanism === ".husky" ? existsSync(join(root, ".husky", "commit-msg")) : hookRefersTool("commit-msg");

  // Install hint follows the ACTIVE mechanism (spec 0013 revision): giving a
  // lefthook repo `pre-commit install` is the wrong instruction — lefthook
  // installs with `lefthook install`.
  const installHintOf = (m: string | null): string => {
    if (m === "lefthook.yml") return "lefthook install";
    if (m === ".husky") return "husky install (or npm install — the prepare script)";
    if (m?.endsWith("(package.json)")) return "npm install (the postinstall installs the hooks)";
    return "pre-commit install --hook-type pre-commit --hook-type commit-msg";
  };
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
    fix = `install the hooks: ${installHintOf(mechanism)}`;
  } else if (mechanism !== null && discipline && hooksActive && !commitMsgActive) {
    score = 0.4;
    detail = `${mechanism} enforces commit discipline (hooks installed, commit-msg stage missing)`;
    // lefthook only installs stages its config declares — "lefthook install"
    // alone leaves the commit-msg hook absent when lefthook.yml has no
    // commit-msg job. The spooner integration template closes that path
    // (review round, 2026-08-16). The template lives in the spooner skill
    // itself (skills/spooner/templates/), never in the target repo — the fix
    // names it accordingly, no bare relative path a user could chase locally.
    fix =
      mechanism === "lefthook.yml"
        ? "install the commit-msg stage: merge the lefthook-commit-msg.yml integration template (shipped with the spooner skill, under its templates/ directory) into lefthook.yml, then run lefthook install"
        : `install the commit-msg stage: ${installHintOf(mechanism)}`;
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
    /\b(gitleaks|trivy|snyk|codeql|pip-audit|osv-scanner)\b/i.test(content) ||
    /^\s{0,2}(security|gitleaks|scan|pip-audit|snyk|trivy|osv)[a-z0-9_-]*:/m.test(content) ||
    /uses: github\/codeql-action/.test(content);
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

/** Java test-framework signal: junit/testng declared in the build manifest
 *  (java has no separate test-config file — the declaration IS the signal). */
function javaTestFrameworkOf(root: string): string | null {
  const pom = readIfExists(join(root, "pom.xml"));
  if (pom && /\b(junit|testng|jupiter)\b/i.test(pom)) return "pom.xml (junit)";
  const gradle = readIfExists(join(root, "build.gradle")) ?? readIfExists(join(root, "build.gradle.kts"));
  if (gradle && /\b(junit|testng|jupiter)\b/i.test(gradle)) return "build.gradle (junit)";
  return null;
}

/** PHP test-framework signal: phpunit declared in composer.json require-dev
 *  (phpunit.xml is matched by the cfg-test config patterns directly). */
function phpTestFrameworkOf(root: string): string | null {
  const composer = readIfExists(join(root, "composer.json"));
  if (composer && /phpunit\/phpunit/.test(composer)) return "composer.json (phpunit)";
  return null;
}

/** PHP test signal for command tracing — phpunit.xml / phpunit in composer.json. */
function phpTestSourceOf(root: string): string | null {
  if (existsSync(join(root, "phpunit.xml")) || existsSync(join(root, "phpunit.xml.dist")))
    return "phpunit.xml (phpunit)";
  return phpTestFrameworkOf(root);
}

function checkCfgTest(root: string): CheckResult {
  const sc = stackCommandSources(root);
  const cmd =
    scriptKey(root, /^test\b|^spec\b/) ??
    (makefileTarget(root, "test") ? "test" : null) ??
    // stack lifecycle commands count as a test command (mvn test / cargo test
    // / go test / python3 -m unittest) — java repos would otherwise be
    // reported as having no test framework
    (sc.hasTest ? sc.source : null);
  const config =
    hasPattern(root, [
      /^vitest\.config/,
      /^jest\.config/,
      /^playwright\.config/,
      /^pytest\.ini/,
      /^conftest\.py/,
      /^phpunit\.xml/,
    ]) ??
    javaTestFrameworkOf(root) ??
    phpTestFrameworkOf(root);
  const testFiles = findTestFiles(root);
  const nonEmpty = testFiles.some((f) =>
    /\b(it|test|describe|assert|expect)\(|self\.assert|\$this->assert|@Test|#\[Test\]|it\s*\(|test\s*\(|test[A-Z]\w*\(/i.test(
      readIfExists(f) ?? "",
    ),
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

/** Test-file scan: known test dirs + root-level test files + test dirs inside
 *  one-level subdirs (monorepo-style). collect recurses — java lives at
 *  src/test/java/… (package dirs), python at tests/unit/…. */
function findTestFiles(root: string): string[] {
  const out: string[] = [];
  const collect = (dir: string) => {
    for (const f of entriesOf(dir) ?? []) {
      const p = join(dir, f);
      if (lstatSync(p).isDirectory()) {
        collect(p);
        continue;
      }
      if (
        /\.(test|spec)\./i.test(f) ||
        /^(test_|.*_test\.|.*_spec\.)/.test(f) ||
        /\.(ts|js|mjs|py|go|rb|rs|java|php|kt|kts)$/.test(f)
      )
        out.push(p);
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
  // Co-located test files (vitest/jest convention): *.test.ts / *.spec.ts sit
  // next to their source (utils/foo.test.ts), never in a test/ dir — the
  // directory walk above misses them (a repo's utils/*.test.ts ×5 + coverage/
  // would score cfg-test only 0.3). Bounded full-tree walk: skip
  // node_modules / vendored / build outputs, cap depth at 4.
  const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out", "target", ".venv", "__pycache__"]);
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const f of entriesOf(dir) ?? []) {
      if (f.startsWith(".")) continue;
      const p = join(dir, f);
      if (lstatSync(p).isDirectory()) {
        if (SKIP_DIRS.has(f) || VENDORED_DIRS.has(f)) continue;
        walk(p, depth + 1);
        continue;
      }
      if (/\.(test|spec)\./i.test(f) || /^test_.*\.(py|js|ts)$/.test(f) || /.*_test\.(go|rs|rb)$/.test(f)) out.push(p);
    }
  };
  walk(root, 0);
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
  // step names sit at deeper indents and don't match. Real security jobs carry
  // diverse names — pip-audit/snyk/trivy/osv jobs are security even when the
  // job name says so (a Node/Python monorepo's security.yml with a `pip-audit`
  // job must not score "no security job"); a codeql workflow is a dedicated
  // security workflow regardless of its job name ("analyze").
  const job =
    /^\s{0,2}(security|gitleaks|scan|pip-audit|snyk|trivy|osv)[a-z0-9_-]*:/m.test(content) ||
    /uses: github\/codeql-action/.test(content);
  const mentioned = /\b(gitleaks|trivy|snyk|codeql|pip-audit|osv-scanner)\b/i.test(content);
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
  // (a "none" fix would be misleading at 0.3).
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
    // PHP co-exists in mixed repos — a committed composer.lock locks the PHP
    // side; "no lockfile" must not be reported while it exists.
    const locks = [...(lock ? [lock] : []), ...(existsSync(join(root, "composer.lock")) ? ["composer.lock"] : [])];
    const score = pinned && locks.length > 0 ? 0.5 : pinned ? 0.3 : 0.1;
    const evidence =
      locks.length > 0
        ? `deps pinned + ${locks.join(" + ")}`
        : pinned
          ? "deps pinned, no lockfile"
          : "deps use wildcard ranges";
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
  // requirements.txt is a python dependency manifest — a fully-pinned file
  // must not score 0 with the false "no dependency manifest"; pyproject.toml
  // above wins when both exist (same precedence as stackCommandSources). pip
  // has no lockfile convention — exact `==` pins are the manifest pin, like
  // java's pom.xml.
  if (existsSync(join(root, "requirements.txt"))) {
    const depLines = (readIfExists(join(root, "requirements.txt")) ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("-") && !l.startsWith("."));
    const unpinned = depLines.some((l) => !/==/.test(l));
    const pinned = depLines.length > 0 && !unpinned;
    const score = lock ? 0.5 : pinned ? 0.3 : 0.1;
    return {
      id: "fresh-deps",
      category: "freshness",
      score,
      max: 0.5,
      evidence: lock
        ? `requirements.txt + ${lock}`
        : pinned
          ? "requirements.txt pins exact versions (==)"
          : depLines.length === 0
            ? "requirements.txt is empty or comment-only"
            : "requirements.txt uses unpinned ranges",
      fix: "pin exact versions (==) and commit a lockfile",
    };
  }
  // composer.json is a php manifest — composer.lock is its checksum lockfile
  // (php convention: commit it); without it the declared constraints are the
  // manifest pin (php must not score "no dependency manifest").
  if (existsSync(join(root, "composer.json"))) {
    const composerLock = existsSync(join(root, "composer.lock"));
    return {
      id: "fresh-deps",
      category: "freshness",
      score: composerLock ? 0.5 : 0.3,
      max: 0.5,
      evidence: composerLock
        ? "composer.json + composer.lock (checksum lockfile)"
        : "composer.json declares versions, no composer.lock",
      fix: "commit composer.lock for reproducible installs",
    };
  }
  // go/rust: the checksum lockfiles are the lockfile signal (these stacks
  // would score 0 forever with the misleading "no dependency manifest").
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
  // zig: build.zig.zon is the dependency manifest and its .dependencies
  // entries carry mandatory hash locks (the zig build system verifies them),
  // so the manifest is the checksum lock — like go.sum, one file (it must
  // not score 0 with the false "no dependency manifest").
  if (existsSync(join(root, "build.zig.zon"))) {
    return {
      id: "fresh-deps",
      category: "freshness",
      score: 0.5,
      max: 0.5,
      evidence: "build.zig.zon (dependencies carry hash locks — zig's checksum manifest)",
      fix: "commit build.zig.zon (zig dependency manifest + hashes)",
    };
  }
  // dart/flutter: pubspec.yaml is the manifest, pubspec.lock its checksum
  // lockfile — dart pub's package-lock.json equivalent, committed by Flutter
  // convention (it must not score 0 with the false "no dependency manifest").
  if (existsSync(join(root, "pubspec.yaml"))) {
    const flutterLock = existsSync(join(root, "pubspec.lock"));
    return {
      id: "fresh-deps",
      category: "freshness",
      score: flutterLock ? 0.5 : 0.3,
      max: 0.5,
      evidence: flutterLock
        ? "pubspec.yaml + pubspec.lock (dart pub checksum lockfile)"
        : "pubspec.yaml declares versions, no pubspec.lock",
      fix: "commit pubspec.lock for reproducible installs",
    };
  }
  // unity: Packages/manifest.json is the Unity Package Manager manifest —
  // it pins exact UPM versions (no ranges); packages-lock.json is its
  // lockfile (Unity 2021.2+, committed by convention). Both live under
  // Packages/ (the pair must not score 0 with the false
  // "no dependency manifest").
  if (existsSync(join(root, "Packages", "manifest.json"))) {
    const upmLock = existsSync(join(root, "Packages", "packages-lock.json"));
    return {
      id: "fresh-deps",
      category: "freshness",
      score: upmLock ? 0.5 : 0.3,
      max: 0.5,
      evidence: upmLock
        ? "Packages/manifest.json + packages-lock.json (UPM lockfile)"
        : "Packages/manifest.json pins exact UPM versions (no packages-lock.json)",
      fix: "commit Packages/packages-lock.json for reproducible installs",
    };
  }
  // ruby: Gemfile is the manifest, Gemfile.lock bundler's checksum lockfile
  // (bundler.io: "checking Gemfile.lock into version control" is the
  // documented convention). Parity-gap closure, spec 0015 slice 1.
  if (existsSync(join(root, "Gemfile"))) {
    const bundleLock = existsSync(join(root, "Gemfile.lock"));
    return {
      id: "fresh-deps",
      category: "freshness",
      score: bundleLock ? 0.5 : 0.3,
      max: 0.5,
      evidence: bundleLock ? "Gemfile + Gemfile.lock (bundler lockfile)" : "Gemfile declares versions, no Gemfile.lock",
      fix: "commit Gemfile.lock for reproducible installs",
    };
  }
  // swift: Package.swift is the SPM manifest, Package.resolved its lockfile
  // (swift.org: Package.resolved records exact resolved versions, committed
  // for app targets). Parity-gap closure, spec 0015 slice 1.
  if (existsSync(join(root, "Package.swift"))) {
    const spmLock = existsSync(join(root, "Package.resolved"));
    return {
      id: "fresh-deps",
      category: "freshness",
      score: spmLock ? 0.5 : 0.3,
      max: 0.5,
      evidence: spmLock
        ? "Package.swift + Package.resolved (SPM lockfile)"
        : "Package.swift declares versions, no Package.resolved",
      fix: "commit Package.resolved for reproducible installs",
    };
  }
  // dotnet: *.csproj PackageReference pins versions; packages.lock.json is
  // NuGet's lockfile (learn.microsoft.com: packages.lock.json for reproducible
  // restore). Parity-gap closure, spec 0015 slice 1.
  const csproj = (entriesOf(root) ?? []).find((f) => f.endsWith(".csproj"));
  if (csproj) {
    const nugetLock = existsSync(join(root, "packages.lock.json"));
    return {
      id: "fresh-deps",
      category: "freshness",
      score: nugetLock ? 0.5 : 0.3,
      max: 0.5,
      evidence: nugetLock
        ? `${csproj} + packages.lock.json (NuGet lockfile)`
        : `${csproj} pins PackageReference versions (no packages.lock.json)`,
      fix: "commit packages.lock.json for reproducible restore",
    };
  }
  // harmonyos: oh-package.json5 is the ohpm manifest (harmonyos.com ohpm:
  // dependency declarations live in oh-package.json5). Parity-gap closure,
  // spec 0015 slice 1 — lockfile convention unverified, manifest-only.
  if (existsSync(join(root, "oh-package.json5"))) {
    return {
      id: "fresh-deps",
      category: "freshness",
      score: 0.3,
      max: 0.5,
      evidence: "oh-package.json5 declares dependency versions (ohpm manifest)",
      fix: "n/a (ohpm lockfile convention not verified)",
    };
  }
  // apple: Podfile / Cartfile / Project.swift declare dependency versions
  // (CocoaPods guides: Podfile at project root; Carthage Artifacts.md:
  // Cartfile in working dir). Podfile.lock is CocoaPods' checksum lockfile
  // (guides.cocoapods.org: committing Podfile.lock is the documented
  // convention) — 0.5 with it, like ruby's Gemfile.lock (the evidence must
  // not claim "no lockfile convention" when one exists).
  if (existsSync(join(root, "Podfile")) || existsSync(join(root, "Cartfile"))) {
    const podLock = existsSync(join(root, "Podfile.lock"));
    return {
      id: "fresh-deps",
      category: "freshness",
      score: podLock ? 0.5 : 0.3,
      max: 0.5,
      evidence: existsSync(join(root, "Podfile"))
        ? podLock
          ? "Podfile + Podfile.lock (CocoaPods checksum lockfile)"
          : "Podfile declares CocoaPods versions (no Podfile.lock)"
        : "Cartfile declares Carthage versions (no lockfile convention)",
      fix: podLock ? "n/a" : "commit Podfile.lock for reproducible installs",
    };
  }
  // c/cpp split: vcpkg.json (manifest mode — learn.microsoft.com: vcpkg.json
  // name required, pins dependency versions) and conanfile.txt (docs.conan.io:
  // [requires] at the project root) DO carry version semantics; CMakeLists.txt
  // / meson.build do not (they declare build targets, not dependencies — the
  // parity ceiling: the blanket c/cpp ceiling would contradict the
  // spec-0014 signals). conan.lock is Conan's generated lockfile
  // (`conan lock create`, docs.conan.io) — 0.5 with it, like ruby's Gemfile.lock.
  if (existsSync(join(root, "vcpkg.json")) || existsSync(join(root, "conanfile.txt"))) {
    const isConan = !existsSync(join(root, "vcpkg.json")) && existsSync(join(root, "conanfile.txt"));
    const conanLock = isConan && existsSync(join(root, "conan.lock"));
    return {
      id: "fresh-deps",
      category: "freshness",
      score: conanLock ? 0.5 : 0.3,
      max: 0.5,
      evidence: conanLock
        ? "conanfile.txt + conan.lock (Conan lockfile)"
        : isConan
          ? "conanfile.txt [requires] pins versions (no conan.lock)"
          : "vcpkg.json pins manifest-mode versions (vcpkg has no committed lockfile convention)",
      fix: conanLock ? "n/a" : isConan ? "commit conan.lock (conan lock create) for reproducible builds" : "n/a",
    };
  }
  // java pins versions in the manifest itself — no lockfile convention.
  if (
    existsSync(join(root, "pom.xml")) ||
    ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].some((f) =>
      existsSync(join(root, f)),
    )
  ) {
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

/** Case-insensitive root README lookup — a lowercase `readme.md` must score
 *  the same on macOS (case-insensitive FS) and Linux CI (sensitive); a
 *  fixed-name existsSync variant would silently diverge between the two. */
export function readmeFileOf(root: string): string | null {
  for (const f of entriesOf(root) ?? []) {
    if (/^readme(\.md)?$/i.test(f) && lstatSync(join(root, f)).isFile()) return f;
  }
  return null;
}

function checkStructReadme(root: string): CheckResult {
  const readmeName = readmeFileOf(root);
  const readme = readmeName ? join(root, readmeName) : null;
  const content = readme ? (readIfExists(readme) ?? "") : "";
  const chars = content.trim().length;
  const headings = content.match(/^#{2,3}\s+/gm)?.length ?? 0;
  let score = 0;
  let detail = `README: ${readme ? "too short (<50 chars)" : "missing"}`;
  if (readme && chars > 50 && headings >= 3) {
    score = 0.5;
    detail = `${readmeName}: ${chars} chars with ${headings} section headings`;
  } else if (readme && chars > 50) {
    score = 0.3;
    detail = `${readmeName}: ${chars} chars, no section headings`;
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
  const rootLevel = ["src", "lib", "packages"].some((d) => {
    const p = join(root, d);
    return existsSync(p) && lstatSync(p).isDirectory();
  });
  // Gradle/Android module layout: settings.gradle(.kts) + module dirs carrying
  // their own src/ (app/src/main/…) — no root src/ must not score 0.
  const gradleProject = ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"].some((f) =>
    existsSync(join(root, f)),
  );
  const moduleSrc = gradleProject
    ? (entriesOf(root) ?? []).some(
        (entry) =>
          !entry.startsWith(".") &&
          !VENDORED_DIRS.has(entry) &&
          existsSync(join(root, entry, "src")) &&
          lstatSync(join(root, entry, "src")).isDirectory(),
      )
    : false;
  // Go's idiomatic layout is cmd/ + pkg/, not src/ (a Makefile-less Go repo
  // with a standard Go tree must not score struct-layout 0 — the only major
  // stack whose conventional layout the check would not recognize).
  const goLayout =
    detect(root).stacks.includes("go") &&
    ["cmd", "pkg"].some((d) => {
      const p = join(root, d);
      return existsSync(p) && lstatSync(p).isDirectory();
    });
  // WXT browser-extension layout (wxt.dev): entrypoints/ is the extension's
  // standard source root (a WXT repo with entrypoints/ + adapters/ must not
  // score 0 — that is the WXT convention).
  const wxtLayout =
    detect(root).stacks.includes("node") &&
    ["entrypoints"].some((d) => {
      const p = join(root, d);
      return existsSync(p) && lstatSync(p).isDirectory();
    });
  // Python flat layout: top-level package dirs — with or without __init__.py
  // (namespace packages; a Python repo's model/ + ui/ must not score 0
  // despite being the idiomatic flat layout).
  const pythonFlat =
    detect(root).stacks.includes("python") &&
    (entriesOf(root) ?? []).some(
      (entry) =>
        !entry.startsWith(".") &&
        !VENDORED_DIRS.has(entry) &&
        existsSync(join(root, entry)) &&
        lstatSync(join(root, entry)).isDirectory() &&
        readdirSync(join(root, entry)).some((f) => f.endsWith(".py")),
    );
  // C/C++'s idiomatic layout: include/ (src/ is already in the generic list —
  // spec 0014 C group; flutter lib/ is likewise already covered).
  const cCppLayout =
    detect(root).stacks.includes("c/cpp") &&
    ["include"].some((d) => {
      const p = join(root, d);
      return existsSync(p) && lstatSync(p).isDirectory();
    });
  const organized = rootLevel || moduleSrc || goLayout || wxtLayout || pythonFlat || cCppLayout;
  // Apple has no strong layout convention — spec 0014 C group documents the
  // ceiling instead of recognizing target-dir layouts (a standard
  // multi-target Xcode tree must not score 0 with a misleading "organize
  // sources under src/" fix — an Xcode repo cannot reasonably do that).
  const appleCeiling = !organized && detect(root).stacks.includes("apple");
  return {
    id: "struct-layout",
    category: "structure",
    score: organized ? 0.5 : 0,
    max: 0.5,
    evidence: moduleSrc
      ? "sources organized under gradle module dirs (e.g. app/src/)"
      : goLayout
        ? "sources organized under cmd/ + pkg/ (Go layout)"
        : wxtLayout
          ? "sources organized under entrypoints/ (WXT layout)"
          : pythonFlat
            ? "sources organized in flat top-level packages (Python layout)"
            : cCppLayout
              ? "sources organized under include/ + src/ (C/C++ layout)"
              : organized
                ? "sources organized under src/ lib/ packages/"
                : appleCeiling
                  ? "Xcode target-dir layout — no recognized convention (documented ceiling)"
                  : "no src/, lib/, or packages/ directory",
    fix: appleCeiling
      ? "not covered — Xcode projects have no recognized layout convention to score"
      : "organize sources under src/, lib/, or packages/ (not covered by transform)",
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
export function runAudit(root: string, verify = false, verifyCommand?: string): AuditResult {
  const items: CheckResult[] = [
    checkAgentsMd(root),
    checkAgentsBridge(root),
    checkAgentsLength(root),
    checkAgentsCommands(root, verify, verifyCommand),
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

  // Normalization layer (decoupled): each category's raw check scores scale
  // from the check maxima to the category weight — the weights
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
  const { maturity, note } = assessMaturity(root, hasBuildCmd, primaryAgentFile(root) !== null, hasCi(root));

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

function parseArgs(argv: string[]): {
  root: string;
  format: "json" | "markdown";
  verify: boolean;
  verifyCommand: string | undefined;
} {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const format = valueOf("--format") === "markdown" ? "markdown" : "json";
  return {
    root: valueOf("--root") ?? process.cwd(),
    format,
    verify: argv.includes("--verify"),
    verifyCommand: valueOf("--verify-command"),
  };
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
if (isDirectEntry(import.meta.url)) {
  assertNodeVersion();
  const { root, format, verify, verifyCommand } = parseArgs(process.argv.slice(2));
  try {
    const result = runAudit(root, verify, verifyCommand);
    process.stdout.write(format === "markdown" ? renderMarkdown(result) : `${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    console.error(`audit: failed to scan ${root}: ${(err as Error).message}`);
    process.exit(1);
  }
}
