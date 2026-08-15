#!/usr/bin/env node
/**
 * transform — Spooner M2: CLI + manifest model + stage status + stage 2
 * gates installer (warn-only, build-green verified) + stage 3 agent files
 * (AGENTS.md from real commands + CLAUDE.md bridge) + stage 4 SDD adoption
 * (docs/sdd/ templates + AGENTS.md convention + CI gate).
 *
 * Agent-driven workflow (specs/0002-m2-transform.md): stage 1 = audit
 * (M1, existing); stages 2-4 apply verified, confirmable changes.
 *
 * Zero dependencies (Node builtins only); runs natively via Node's
 * type stripping — no build step:
 *   node skills/spooner/scripts/transform.ts [--root <path>] [--stage 2|3|4|all] [--dry-run] [--ci github|gitlab|none] [--gates warn-only|hard] [--format json|markdown]
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { isDirectEntry } from "./entry.ts";
import { detect, PYTHON_FILES } from "./detect.ts";
import { DYNAMIC_LIFECYCLE_STACKS, GO_TEST_COMMAND, STACK_COMMANDS } from "./stacks.ts";

const MANIFEST_FILE = ".ai-native.yml";
const SCHEMA_VERSION = 1;
const TOOL_NAME = "spooner";
export const TOOL_VERSION = "0.13.0";

/** Output files per stage (pinned in specs/0002 §per-stage outputs). */
const STAGE_FILES: Record<number, string[]> = {
  2: [".commitlintrc.json", ".pre-commit-config.yaml", ".markdownlint-cli2.yaml", ".github/workflows/ai-native.yml"],
  3: ["AGENTS.md", "CLAUDE.md"],
  4: ["docs/sdd/spec.md", "docs/sdd/plan.md", "docs/sdd/tasks.md", ".github/workflows/sdd.yml"],
};

/** Stage-4 template map: SDD docs + the spec-existence CI gate. The gate is
 *  skipped on non-GitHub platforms — same routing as stage 2 (stage 4 must
 *  not install a dead .github/workflows/sdd.yml on GitLab). */
export function stage4Templates(root: string, ciOverride?: string): Record<string, string> {
  const tpl = { ...STAGE4_TEMPLATES };
  if (!workflowEligible(root, ciOverride)) delete tpl[".github/workflows/sdd.yml"];
  return tpl;
}

interface ManifestStage {
  date: string;
  /** Tool version whose templates this stage installed (M4; absent on pre-M4 manifests). */
  templateVersion?: string;
  warnOnly?: boolean;
  /** CI gate strictness the installed workflow was rendered with (spec 0008
   *  question 5; absent when no workflow was installed — no-workflow mode). */
  gates?: GatesStrictness;
  files: string[];
}

/** Gate strictness (spec 0008 question 5): warn-only quality jobs (default —
 *  template bytes verbatim) or hard quality jobs (continue-on-error removed). */
export type GatesStrictness = "warn-only" | "hard";

/** Render a workflow template for the chosen gate strictness. The template
 *  bytes stay warn-only (the default); hard is a transform-time render — same
 *  contract as spec 0008's platform routing (template bytes unchanged ⇒ no
 *  TOOL_VERSION bump). */
export function renderWorkflow(tpl: string, gates: GatesStrictness): string {
  if (gates === "warn-only") return tpl;
  return (
    tpl
      .replace(/^[ \t]*continue-on-error: true\n/gm, "")
      // Header + quality-job names must not claim warn-only in a hard render —
      // the stack description varies per template (java's runs three lines), so
      // match the warn-only claims generically and keep the rest of the text.
      .replace("; warn-only\n# quality gates; hard gates: ", "; hard gates:\n# quality jobs + ")
      .replace("; warn-only quality gates; hard gates:\n# ", "; hard gates:\n# quality jobs + ")
      .replace(/, warn-only\)/g, ")")
      // Bare "(warn-only)" sits at end-of-line ("lint + test (warn-only)\n") —
      // eat the leading space so the rendered line keeps no trailing whitespace
      // (the generated trailing-whitespace hook would strip it, making sync
      // report an untouched hard install as permanently "modified").
      .replace(/ \(warn-only\)\n/g, "\n")
  );
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
  const lines: string[] = [
    `schemaVersion: ${m.schemaVersion}`,
    `tool: ${m.tool}`,
    `version: "${m.version}"`,
    "stages:",
  ];
  for (const [stage, s] of Object.entries(m.stages)) {
    lines.push(`  ${stage}:`, `    date: "${s.date}"`);
    if (s.templateVersion !== undefined) lines.push(`    templateVersion: "${s.templateVersion}"`);
    if (s.warnOnly !== undefined) lines.push(`    warnOnly: ${s.warnOnly}`);
    if (s.gates !== undefined) lines.push(`    gates: ${s.gates}`);
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
    if (
      parsed["schemaVersion"] !== SCHEMA_VERSION ||
      parsed["tool"] !== TOOL_NAME ||
      typeof stagesRaw !== "object" ||
      stagesRaw === null ||
      Array.isArray(stagesRaw)
    ) {
      throw new Error(`schema mismatch (expected schemaVersion ${SCHEMA_VERSION}, tool ${TOOL_NAME}, stages map)`);
    }
    const stages: Record<string, ManifestStage> = {};
    const topVersion = typeof parsed["version"] === "string" ? parsed["version"] : TOOL_VERSION;
    for (const [k, v] of Object.entries(stagesRaw)) {
      const s = v as {
        date?: unknown;
        warnOnly?: unknown;
        gates?: unknown;
        files?: unknown;
        templateVersion?: unknown;
      };
      if (
        typeof s !== "object" ||
        s === null ||
        typeof s.date !== "string" ||
        !Array.isArray(s.files) ||
        s.files.some((f) => typeof f !== "string")
      ) {
        throw new Error(`stage "${k}" entry malformed`);
      }
      const tv = s.templateVersion;
      stages[k] = {
        date: s.date,
        files: s.files as string[],
        warnOnly: s.warnOnly === true ? true : undefined,
        gates: s.gates === "warn-only" || s.gates === "hard" ? s.gates : undefined,
        // per-stage version, else the manifest-level version (pre-M4 manifests), else current
        templateVersion: typeof tv === "string" && tv !== "" ? tv : topVersion,
      };
    }
    return {
      present: true,
      manifest: {
        schemaVersion: parsed["schemaVersion"] as number,
        tool: parsed["tool"] as string,
        version: topVersion,
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
  writeFileSync(
    join(root, MANIFEST_FILE),
    stringifyManifest({ schemaVersion: SCHEMA_VERSION, tool: TOOL_NAME, version: TOOL_VERSION, stages }),
    "utf8",
  );
}

// --- stage 2: gates installer ---------------------------------------------------

/** Cross-stack gates (installed for every stack; decision #13). The pre-commit
 *  config is NOT here — it is generated from detected tooling (M10, spec 0010). */
export const STAGE2_COMMON: Record<string, string> = {
  ".commitlintrc.json": "commitlintrc.json",
  ".markdownlint-cli2.yaml": "markdownlint-cli2.yaml",
};

/** Pre-existing markdownlint configs that cli2 would silently MERGE with the
 *  generated .markdownlint-cli2.yaml — the merge overrides the generated rule
 *  disables and the gate runs with unexpected defaults (a repo's own
 *  .markdownlint.yml can dilute the generated config's MD060:false → ~21k
 *  errors incl. spooner's own SDD templates flagged). When one exists, the
 *  gate follows the repo's own config. */
const MARKDOWNLINT_FOREIGN_CONFIGS = [
  ".markdownlint.yml",
  ".markdownlint.yaml",
  ".markdownlint.json",
  ".markdownlint.jsonc",
  ".markdownlintrc",
  ".markdownlint-cli2.json",
  ".markdownlint-cli2.jsonc",
  ".markdownlint-cli2.cjs",
  ".markdownlint-cli2.mjs",
] as const;

function foreignMarkdownlintConfigOf(root: string): string | null {
  return MARKDOWNLINT_FOREIGN_CONFIGS.find((name) => existsSync(join(root, name))) ?? null;
}

/** Pre-existing commitlint configs — installing .commitlintrc.json beside one
 *  lets cosmiconfig's resolution order silently shadow the repo's own config
 *  (a repo's commitlint.config.mjs tightened header-max-length to 72; the
 *  installed .commitlintrc.json default 100 would win the resolution). Skip
 *  the install, keep the repo's config. */
const COMMITLINT_FOREIGN_CONFIGS = [
  ".commitlintrc",
  ".commitlintrc.js",
  ".commitlintrc.cjs",
  ".commitlintrc.yaml",
  ".commitlintrc.yml",
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
] as const;

function foreignCommitlintConfigOf(root: string): string | null {
  const named = COMMITLINT_FOREIGN_CONFIGS.find((name) => existsSync(join(root, name)));
  if (named) return named;
  const pkg = packageJsonOf(root);
  return pkg !== null && typeof (pkg as Record<string, unknown>)["commitlint"] === "object"
    ? "package.json (commitlint field)"
    : null;
}

/** Supported stack → workflow template (verbatim copies, zero parameters). */
export const STAGE2_WORKFLOWS: Record<string, string> = {
  node: "ci-workflow-node.yml",
  python: "ci-workflow-python.yml",
  go: "ci-workflow-go.yml",
  java: "ci-workflow-java.yml",
  rust: "ci-workflow-rust.yml",
};

const STACK_PRIORITY: string[] = ["node", "python", "go", "java", "rust"];

/** First supported stack in the repo (node > python > go > java > rust), else null. */
export function primaryStack(root: string): string | null {
  const stacks = detect(root).stacks;
  return STACK_PRIORITY.find((s) => stacks.includes(s)) ?? null;
}

/** CI platforms present in the repo (the same file families the audit scans). */
export function ciPlatforms(root: string): string[] {
  const out: string[] = [];
  if (existsSync(join(root, ".github", "workflows"))) out.push("github");
  if (existsSync(join(root, ".gitlab-ci.yml"))) out.push("gitlab");
  if (existsSync(join(root, "Jenkinsfile"))) out.push("jenkins");
  if (existsSync(join(root, "azure-pipelines.yml"))) out.push("azure");
  if (existsSync(join(root, ".circleci"))) out.push("circleci");
  if (existsSync(join(root, ".travis.yml"))) out.push("travis");
  return out;
}

/** Host of the repo's origin remote (null when none is configured). */
function gitRemoteHost(root: string): string | null {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const host = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)/i)?.[1] ?? null;
    if (!host || !host.includes(".")) return null; // local/file remotes carry no host signal
    const h = host.toLowerCase();
    if (h.includes("github")) return "github";
    if (h.includes("gitlab")) return "gitlab";
    return h;
  } catch {
    return null;
  }
}

/**
 * Why the GitHub workflow template is skipped (null = it applies). Detection
 * order (spec 0008): an explicit --ci override wins; local CI files next; a
 * greenfield repo with no CI files consults the origin remote host — a
 * GitLab remote must not receive a dead .github/workflows file.
 */
export function workflowSkipReason(root: string, ciOverride?: string): string | null {
  if (ciOverride === "github") return null;
  if (ciOverride === "gitlab" || ciOverride === "none")
    return `CI workflow skipped: ${ciOverride} (explicit) — cross-stack gates installed`;
  const platforms = ciPlatforms(root);
  if (platforms.length > 0 && !platforms.includes("github"))
    return `CI workflow skipped: detected ${platforms.join("/")} (non-GitHub) — cross-stack gates installed`;
  if (platforms.length === 0) {
    const host = gitRemoteHost(root);
    if (host !== null && host !== "github")
      return `CI workflow skipped: origin remote host ${host} (non-GitHub) — cross-stack gates installed`;
  }
  return null;
}

/** Whether the GitHub workflow template applies (spec 0008 + greenfield remote). */
export function workflowEligible(root: string, ciOverride?: string): boolean {
  return workflowSkipReason(root, ciOverride) === null;
}

/** Stage-2 template map for a repo: cross-stack gates + its stack's workflow.
 *  The pre-commit config is generated (M10) unless the repo keeps another hook
 *  ecosystem (husky / lefthook — skip + notice, the spec 0008 treatment). */
export function stage2Templates(root: string, ciOverride?: string): Record<string, string> {
  const stack = primaryStack(root);
  const tpl = { ...STAGE2_COMMON };
  if (stack && workflowEligible(root, ciOverride)) tpl[".github/workflows/ai-native.yml"] = STAGE2_WORKFLOWS[stack];
  const ecosystem = hookToolEcosystem(root);
  if (ecosystem !== "husky" && ecosystem !== "lefthook" && ecosystem !== "yorkie") tpl[PRE_COMMIT_FILE] = GENERATED;
  // A pre-existing markdownlint config would merge with the generated one and
  // override its rule disables — skip the install, keep the repo's config.
  if (foreignMarkdownlintConfigOf(root) !== null) delete tpl[".markdownlint-cli2.yaml"];
  // A pre-existing commitlint config would be shadowed by the installed
  // .commitlintrc.json (cosmiconfig resolution order) — skip, keep the repo's.
  if (foreignCommitlintConfigOf(root) !== null) delete tpl[".commitlintrc.json"];
  return tpl;
}

// --- M10: stack-aware pre-commit generation + hook-tool routing ------------------

export const PRE_COMMIT_FILE = ".pre-commit-config.yaml";

/** Marker for generated content in stage2Templates (M10). */
const GENERATED = "@generated";

/** Tool-owned workflow marker: the generated header names its stack. A
 *  workflow carrying this stack's header is tool-owned across version bumps
 *  (a stale baked EXPECTED after a TOOL_VERSION bump re-renders instead of
 *  conflicting — the installed workflow would otherwise lag behind a bump);
 *  other stacks' headers keep the wrong-stack conflict + delete-and-re-run
 *  hint. */
function generatedWorkflowMarker(stack: string): string {
  return `# CI workflow installed by spooner transform Stage 2 (${stack} stack`;
}

export type HookTool = "pre-commit" | "husky" | "lefthook" | "yorkie" | "none";

/**
 * Existing git-hook ecosystem (M10): husky/lefthook/yorkie repos keep their
 * own hooks — the generated pre-commit config would be a foreign gate file.
 * A bare dependency name WITHOUT hooks configuration is a DEAD dependency —
 * it must not block the gate install (vue2 upgrade leftovers: husky in
 * devDependencies, no .husky/, no husky field). Active forms:
 * husky v7+ = a `.husky/` directory; husky v4 / yorkie (vue-cli default) =
 * a package.json field with a `hooks` map, dependency present.
 */
export function hookToolEcosystem(root: string): HookTool {
  if (existsSync(join(root, "lefthook.yml"))) return "lefthook";
  if (existsSync(join(root, PRE_COMMIT_FILE))) return "pre-commit";
  const pkg = packageJsonOf(root);
  const all = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, unknown>;
  const fieldOf = (name: string): boolean => {
    const v = pkg !== null ? (pkg as Record<string, unknown>)[name] : undefined;
    return v !== undefined && v !== null && typeof v === "object" && !Array.isArray(v);
  };
  // yorkie (vue-cli) reads either its own `yorkie` field or the legacy
  // `gitHooks` field (vue-cli 2/3 — husky-v4-compatible schema); a yorkie
  // dependency with gitHooks configured is ACTIVE.
  if (all["yorkie"] !== undefined && (fieldOf("yorkie") || fieldOf("gitHooks"))) return "yorkie";
  if (existsSync(join(root, ".husky")) || (all["husky"] !== undefined && fieldOf("husky"))) return "husky";
  return "none";
}

/** Files at the repo root (M10 detection — the same root boundary as detect). */
function hasAny(root: string, names: string[]): boolean {
  return names.some((n) => existsSync(join(root, n)));
}

function pythonPresent(root: string): boolean {
  // Single-sourced from detect's python signals (hardening 2026-08-11) —
  // the audit, the CI workflow, and the ruff/pytest gates must agree on
  // what makes a directory a python project.
  return hasAny(root, PYTHON_FILES);
}

function pytestPresent(root: string): boolean {
  if (hasAny(root, ["pytest.ini", "tox.ini", "tests"])) return true;
  try {
    return readFileSync(join(root, "pyproject.toml"), "utf8").includes("[tool.pytest.ini_options]");
  } catch {
    return false;
  }
}

function pipAuditPresent(root: string): boolean {
  return existsSync(join(root, "requirements.txt"));
}

function eslintPresent(root: string): boolean {
  if (
    hasAny(root, [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      ".eslintrc.json",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.yml",
    ])
  )
    return true;
  const pkg = packageJsonOf(root);
  return pkg !== null && pkg["eslintConfig"] !== undefined;
}

function tsconfigPresent(root: string): boolean {
  return hasAny(root, ["tsconfig.json"]);
}

function declaredScript(root: string, key: string): boolean {
  const pkg = packageJsonOf(root);
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {};
  return typeof scripts[key] === "string";
}

/** Declared npm script wrapper (the existing template pattern): runs the script
 *  when declared, skips with a notice otherwise — never masks a real failure. */
function declaredWrapper(key: string): string {
  return `bash -c 'node -e "const{execSync}=require(\\"node:child_process\\");const s=require(\\"./package.json\\").scripts||{};if(typeof s.${key}===\\"string\\"){console.log(\\"> npm run ${key}\\");execSync(\\"npm run ${key}\\",{stdio:\\"inherit\\"})}else console.log(\\"no ${key} script declared — skipped\\")"'`;
}

/** Rendered hook-exclude regex sources — the ONLY place that reasons about
 *  regex escaping (pitfall class 4: the template-literal `\.` can be
 *  swallowed — three-backslash workarounds and four-backslash runs render a
 *  double backslash into the generated exclude). `String.raw` makes the
 *  source text byte-identical to the rendered YAML — no backslash counting.
 *  The rendered exclude bytes are pinned by the preCommit byte assertions
 *  (spec 0015 slice 4). */
const EXCLUDE_CLANG_FORMAT = String.raw`\.clang-format$`;
const EXCLUDE_JSONC = String.raw`^(\.devcontainer|\.vscode)/|(^|/)tsconfig.*\.json$`;

/** Cross-stack core (always): hygiene + markdownlint + commitlint + gitleaks. */
const PRE_COMMIT_CORE = `  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v6.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
        # .clang-format is multi-document YAML — not a manifest; check-yaml
        # would fail every commit on any C/C++ repo
        exclude: '${EXCLUDE_CLANG_FORMAT}'
      - id: check-json
        # .devcontainer/ + .vscode/ are JSONC — comments and trailing commas
        # are the VSCode ecosystem's standard formats; tsconfig.json is JSONC
        # to the TS toolchain too (comments/trailing commas accepted, e.g.
        # Docusaurus scaffolds); strict JSON decode fails them on every commit
        exclude: '${EXCLUDE_JSONC}'
      - id: check-merge-conflict
      - id: check-added-large-files
      - id: check-symlinks
  - repo: https://github.com/DavidAnson/markdownlint-cli2
    rev: v0.23.2
    hooks:
      - id: markdownlint-cli2
        additional_dependencies:
          - markdownlint-cli2@0.23.2
  - repo: https://github.com/alessandrojcm/commitlint-pre-commit-hook
    rev: v9.26.0
    hooks:
      - id: commitlint
        stages: [commit-msg]
        additional_dependencies:
          - "@commitlint/cli@21.2.1"
          - "@commitlint/config-conventional@21.2.0"
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.24.3
    hooks:
      - id: gitleaks`;

/** Self-contained manifest gate (spec 0012): mirrors the CI hard-gate job's
 *  python3 script (baked EXPECTED — spec 0005's baked-version rule) so user
 *  repos get the same local gate. Zero deps: no spooner scripts required in
 *  the target repo; python3 is guaranteed wherever pre-commit runs
 *  (pre-commit itself is a python tool — node is not). The parity test keeps
 *  this copy and the five workflow templates' copies from drifting. */
const MANIFEST_GATE_SCRIPT = `import sys, os, re
# baked at install time; must track the spooner TOOL_VERSION that
# shipped this workflow (docs/08 ledger rule: every bump updates it)
EXPECTED = "@EXPECTED@"

def parse_yaml(text):
    lines = [(len(l) - len(l.lstrip()), l) for l in text.split("\\n")]
    i = 0
    def parse_block(indent):
        nonlocal i
        obj = {}
        arr = []
        is_array = False
        while i < len(lines):
            ind, raw = lines[i]
            trimmed = raw.strip()
            if not trimmed or trimmed.startswith("#"):
                i += 1
                continue
            if ind < indent:
                break
            if ind > indent:
                raise ValueError("unexpected indent at " + trimmed)
            if trimmed.startswith("- "):
                is_array = True
                arr.append(scalar(trimmed[2:]))
                i += 1
                continue
            if is_array:
                raise ValueError("mixed map/array at " + trimmed)
            m = re.match(r"^([^:]+):\\s*(.*)$", trimmed)
            if not m:
                raise ValueError("cannot parse line " + trimmed)
            key = m.group(1).strip()
            rest = m.group(2).strip()
            if rest == "":
                i += 1
                obj[key] = parse_block(lines[i][0]) if i < len(lines) and lines[i][0] > ind else None
            else:
                obj[key] = scalar(rest)
                i += 1
        return arr if is_array else obj
    def scalar(raw):
        v = raw.strip()
        if v == "true":
            return True
        if v == "false":
            return False
        if v == "null" or v == "~":
            return None
        q = re.match(r"^\\"([^\\"]*)\\"$", v)
        if q:
            return q.group(1)
        return float(v) if re.match(r"^-?\\d+(\\.\\d+)?$", v) else v
    return parse_block(0)

def _int(s):
    try:
        return int(s)
    except ValueError:
        return None

def lt(a, b):
    pa = [_int(p) for p in a.split(".")]
    pb = [_int(p) for p in b.split(".")]
    for k in range(max(len(pa), len(pb))):
        x = pa[k] if k < len(pa) else 0
        y = pb[k] if k < len(pb) else 0
        if x is None or y is None:
            return a < b
        if x != y:
            return x < y
    return False

def stage_hint(missing):
    if any(f.startswith("docs/sdd") or f.endswith("sdd.yml") for f in missing):
        return 4
    if any(f == "AGENTS.md" or f == "CLAUDE.md" for f in missing):
        return 3
    return 2

if not os.path.exists(".ai-native.yml"):
    print("ai-native: no .ai-native.yml manifest — run transform stage 2 first", file=sys.stderr)
    sys.exit(1)
try:
    with open(".ai-native.yml", "r", encoding="utf-8") as fh:
        m = parse_yaml(fh.read())
except Exception as e:
    print("ai-native: manifest parse error — " + str(e), file=sys.stderr)
    sys.exit(1)
if not isinstance(m, dict) or m.get("schemaVersion") != 1 or m.get("tool") != "spooner" or not isinstance(m.get("stages"), dict):
    print("ai-native: manifest schema mismatch (expected schemaVersion 1, tool spooner, stages map)", file=sys.stderr)
    sys.exit(1)
missing = []
for s in m["stages"].values():
    if isinstance(s, dict) and isinstance(s.get("files"), list):
        for f in s["files"]:
            if isinstance(f, str) and not os.path.exists(f):
                missing.append(f)
if missing:
    print("ai-native: manifest drift — missing: " + ", ".join(missing) + " — re-run transform stage " + str(stage_hint(missing)), file=sys.stderr)
    sys.exit(1)
version = m.get("version")
version = version if isinstance(version, str) else "0.0.0"
if lt(version, EXPECTED):
    print("ai-native: installed templates v" + version + " < expected v" + EXPECTED + " — run sync to apply the current templates", file=sys.stderr)
    sys.exit(1)
print("ai-native: consistent (" + str(len(m["stages"])) + " stage(s) at v" + version + ")")
`;

/** The gate script with the current TOOL_VERSION baked (spec 0005 rule). */
export function manifestGateScript(): string {
  return MANIFEST_GATE_SCRIPT.replace('"@EXPECTED@"', `"${TOOL_VERSION}"`);
}

/** Escape for a YAML double-quoted scalar (\\, ", \n — the subset we emit). */
function yamlEscaped(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Python gates (only when python tooling detected; ruff managed + rev-pinned,
 *  pytest/pip-audit local — SKIP'd in the python workflow template). */
function pythonHooks(root: string): string | null {
  if (!pythonPresent(root)) return null;
  const lines: string[] = [];
  lines.push(`  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.16.1
    hooks:
      - id: ruff
        files: \\.py$
      - id: ruff-format
        args: [--check]
        files: \\.py$`);
  if (pytestPresent(root)) {
    // Missing local tool is not a failing build (the audit's exit-127 rule,
    // pip-audit pattern): a machine without the pytest module fails
    // "python3 -m pytest" with ModuleNotFoundError — an environment gap, not
    // a broken build. Pre-check --version and skip with a notice naming the
    // escape; a real test failure still fails the hook (the hard gate stays).
    // bash -c wrapped: system hooks never run through a shell — the entry is
    // shlex-split and the first token exec'd directly.
    lines.push(`  - repo: local
    hooks:
      - id: pytest
        name: pytest (python)
        entry: 'bash -c ''python3 -m pytest --version >/dev/null 2>&1 || { echo "pytest not installed - SKIP=pytest or pip install pytest (a missing local tool is not a failing build)"; exit 0; }; exec python3 -m pytest -q'' bash'
        language: system
        pass_filenames: false
        files: \\.py$
        stages: [pre-commit]`);
  }
  if (pipAuditPresent(root)) {
    // Missing local tool is not a failing build (the audit's exit-127 rule):
    // a machine without pip-audit must not block every commit with
    // "Executable pip-audit not found" — skip with a notice and name the
    // escape (SKIP=pip-audit / pip install pip-audit). The skip logic is
    // bash -c wrapped: system hooks never run through a shell — the entry is
    // shlex-split and the first token exec'd directly, so a bare `command -v`
    // builtin fails executable resolution on Linux ("Executable `command`
    // not found"; macOS /usr/bin/command would mask it locally).
    lines.push(`  - repo: local
    hooks:
      - id: pip-audit
        name: pip-audit (python deps)
        entry: 'bash -c ''command -v pip-audit >/dev/null 2>&1 || { echo "pip-audit not installed - SKIP=pip-audit or pip install pip-audit"; exit 0; }; exec pip-audit -r requirements.txt'' bash'
        language: system
        pass_filenames: false
        files: ^requirements\\.txt$
        stages: [pre-commit]`);
  }
  return lines.join("\n");
}

/** Node gates (only when tooling detected; eslint managed + rev-pinned,
 *  typecheck/test local — SKIP'd in the node workflow template). */
/** The repo declares prettier (a devDependency, or a lint script running
 *  it) — CI's declared lint runs prettier --check, so the local hook mirrors
 *  it; prettier is the one hook allowed to write (deterministic formatter —
 *  the same input always produces the same output, unlike eslint/ruff
 *  --fix), spec 0010's no-write rule exempts it. */
function prettierPresent(root: string): boolean {
  const pkg = packageJsonOf(root);
  const dev =
    pkg && typeof pkg.devDependencies === "object" && pkg.devDependencies !== null
      ? (pkg.devDependencies as Record<string, unknown>)
      : {};
  if (typeof dev["prettier"] === "string") return true;
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {};
  return typeof scripts["lint"] === "string" && /prettier/.test(scripts["lint"]);
}

function nodeHooks(root: string): string | null {
  const typecheckable = tsconfigPresent(root) || declaredScript(root, "typecheck");
  if (!eslintPresent(root) && !typecheckable && !declaredScript(root, "test") && !prettierPresent(root)) return null;
  const lines: string[] = [];
  if (eslintPresent(root)) {
    // types: [] — mirrors-eslint defaults to types: [javascript], which
    // filters .ts files out (pre-commit's identify tags them typescript),
    // leaving a dead eslint gate on pure-TS repos.
    // The files pattern already scopes js/ts; no type filtering needed.
    lines.push(`  - repo: https://github.com/pre-commit/mirrors-eslint
    rev: v10.0.3
    hooks:
      - id: eslint
        args: [--max-warnings, "0"]
        files: \\.[jt]sx?$
        types: []
        additional_dependencies:
          - eslint@10.0.3`);
  }
  if (prettierPresent(root)) {
    // --write: prettier is deterministic — auto-formatting is safe and is
    // what a developer would run anyway (npx prettier --write); pre-commit
    // then flags the rewritten files for a re-add before commit.
    // A LOCAL hook runs the repo's own prettier (node_modules) — the
    // mirrors-prettier managed hook lags prettier releases (v3.1.0 max at
    // the time of writing vs prettier 3.9.x in the wild), which would
    // re-introduce the very check-set mismatch this hook exists to close.
    // Missing node_modules is not a failing build (pip-audit pattern):
    // skip with a notice; CI's declared lint stays the hard check.
    lines.push(`  - repo: local
    hooks:
      - id: prettier
        name: prettier (auto-format, project version)
        entry: 'bash -c ''[ -x node_modules/.bin/prettier ] || { echo "prettier not installed - SKIP=prettier or npm install"; exit 0; }; exec node_modules/.bin/prettier --write "$@"'' bash'
        language: system
        types_or: [javascript, jsx, ts, tsx, json, yaml, markdown, css, scss, html, graphql, less]
        stages: [pre-commit]`);
  }
  // Local hooks share one `repo: local` block — emitted only when at least
  // one exists (a plain-JS repo with a test script but no tsconfig must not
  // orphan the test hook under the eslint repo).
  const local: string[] = [];
  if (typecheckable) {
    local.push(`      - id: typecheck
        name: TypeScript typecheck (${tsconfigPresent(root) ? "tsc" : "declared"})
        entry: ${tsconfigPresent(root) ? "bash -c 'npx tsc --noEmit'" : declaredWrapper("typecheck")}
        language: system
        pass_filenames: false
        always_run: true
        stages: [pre-commit]`);
  }
  if (declaredScript(root, "test")) {
    local.push(`      - id: test
        name: npm test (declared)
        entry: ${declaredWrapper("test")}
        language: system
        pass_filenames: false
        always_run: true
        stages: [pre-commit]`);
  }
  if (local.length > 0)
    lines.push(`  - repo: local
    hooks:
${local.join("\n")}`);
  return lines.join("\n");
}

/** Go gates (local system hooks — go toolchain is the repo's own; SKIP'd in
 *  the go workflow template). go-test is bash -c wrapped: `$(...)`/`|` only
 *  work inside a shell — as a bare system entry pre-commit execs them as
 *  literal go args ("malformed import path"). */
function goHooks(root: string): string | null {
  if (!hasAny(root, ["go.mod"])) return null;
  return `  - repo: local
    hooks:
      - id: gofmt
        name: gofmt (format check)
        entry: gofmt -l .
        language: system
        pass_filenames: false
        files: \\.go$
        stages: [pre-commit]
      - id: go-vet
        name: go vet
        entry: go vet ./...
        language: system
        pass_filenames: false
        files: \\.go$
        stages: [pre-commit]
      - id: go-test
        name: go test
        entry: 'bash -c ''go test $(go list ./... | grep -v /test/e2e)'' bash'
        language: system
        pass_filenames: false
        files: \\.go$
        stages: [pre-commit]`;
}

/** Java gates (local system hook — SKIP'd in the java workflow template). */
function javaHooks(root: string): string | null {
  // settings.gradle(.kts) marks a gradle project whose build files live in
  // module dirs (Android: app/build.gradle.kts) — a root-only check would
  // miss every kotlin/Android layout.
  if (!hasAny(root, ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]))
    return null;
  const gradle = hasAny(root, ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]);
  const entry = gradle
    ? existsSync(join(root, "gradlew"))
      ? "./gradlew build"
      : "gradle build"
    : existsSync(join(root, "mvnw"))
      ? "./mvnw -q -B test"
      : "mvn -q -B test";
  return `  - repo: local
    hooks:
      - id: java-test
        name: ${gradle ? "gradle build" : "mvn test"} (java)
        entry: ${entry}
        language: system
        pass_filenames: false
        files: (\\.java$|\\.kt$|pom\\.xml$|build\\.gradle$|build\\.gradle\\.kts$)
        stages: [pre-commit]`;
}

/** Rust gates (local system hooks — cargo/rustfmt/clippy ship with the toolchain;
 *  clippy without -D warnings keeps style warnings soft; SKIP'd in the rust workflow). */
function rustHooks(root: string): string | null {
  if (!hasAny(root, ["Cargo.toml"])) return null;
  return `  - repo: local
    hooks:
      - id: cargo-fmt
        name: cargo fmt (format check)
        entry: cargo fmt --check
        language: system
        pass_filenames: false
        files: \\.rs$
        stages: [pre-commit]
      - id: cargo-clippy
        name: cargo clippy (lint, soft)
        entry: cargo clippy --all-targets
        language: system
        pass_filenames: false
        files: \\.rs$
        stages: [pre-commit]
      - id: cargo-test
        name: cargo test
        entry: cargo test
        language: system
        pass_filenames: false
        files: \\.rs$
        stages: [pre-commit]`;
}

/** Deterministic stack-aware pre-commit config (M10, spec 0010): cross-stack
 *  core always; stack gates only for tooling actually detected (no dead hooks);
 *  check-only; managed repos rev-pinned; local hooks scoped to pre-commit. */
/** SKILL.md authors (a SKILL.md at the root or under skills/) get a
 *  skills-ref validation gate — the CI-only spec check becomes local. The
 *  missing tool is not a failing build (pip-audit pattern): skip with an
 *  explicit notice; CI's SKILL.md job remains the hard check. The skip-or-run
 *  logic is bash -c wrapped: system hooks never run through a shell — a bare
 *  `command -v` builtin fails executable resolution on Linux (macOS's
 *  /usr/bin/command would mask it locally). */
function skillHooks(root: string): string | null {
  const rootSkill = existsSync(join(root, "SKILL.md"));
  let nested = false;
  try {
    nested =
      existsSync(join(root, "skills")) &&
      readdirSync(join(root, "skills")).some((d) => existsSync(join(root, "skills", d, "SKILL.md")));
  } catch {
    nested = false;
  }
  if (!rootSkill && !nested) return null;
  return `  - repo: local
    hooks:
      - id: skills-ref-validate
        name: SKILL.md spec validation (skills-ref)
        entry: 'bash -c ''command -v agentskills >/dev/null 2>&1 || { echo "agentskills not installed - SKIP=skills-ref-validate or pip install skills-ref"; exit 0; }; for f in SKILL.md skills/*/SKILL.md; do [ -f "$f" ] && agentskills validate "$f" || exit 1; done'' bash'
        language: system
        pass_filenames: false
        files: ^(SKILL\\.md|skills/.+/SKILL\\.md)$
        stages: [pre-commit]`;
}

export function generatePreCommitConfig(root: string): string {
  const sections = [
    `${GENERATED_PRE_COMMIT_MARKER} (M10: stack-aware)`,
    "# Install hooks (commitlint runs on the commit-msg stage — both are required):",
    "#   pre-commit install --hook-type pre-commit --hook-type commit-msg",
    "# Full run: pre-commit run --all-files",
    "# NOTE: the hook repos below are fetched from GitHub when pre-commit runs — with",
    "# GitHub unreachable (no mirror/proxy configured), pre-commit cannot prepare the",
    "# hook environment and commits are BLOCKED; make GitHub reachable first.",
    "# Regenerate: delete this file and re-run `transform --stage 2` — the hook set",
    "# follows the repo's detected tooling (what audit credits, transform installs).",
    "repos:",
    PRE_COMMIT_CORE,
    // M12 (spec 0012): self-contained manifest gate — mirrors the CI hard gate
    // so a stale/drifting ledger turns local pre-commit red (baked EXPECTED).
    `  - repo: local
    hooks:
      - id: manifest-consistency
        name: .ai-native.yml consistency + template version (gate)
        entry: "${yamlEscaped(`python3 -c '${manifestGateScript()}'`)}"
        language: system
        pass_filenames: false
        always_run: true
        stages: [pre-commit]`,
    skillHooks(root),
    pythonHooks(root),
    nodeHooks(root),
    goHooks(root),
    rustHooks(root),
    javaHooks(root),
  ].filter((s): s is string => s !== null);
  return `${sections.join("\n")}\n`;
}

/** Resolve stage-2 file content: generated (M10) or template bytes —
 *  workflows render for the chosen gate strictness (spec 0008 question 5). */
function stage2Content(root: string, file: string, tpl: string, gates: GatesStrictness): string {
  if (tpl === GENERATED) return generatePreCommitConfig(root);
  const content = templateContent(tpl);
  return file.endsWith(".github/workflows/ai-native.yml") || file.endsWith(".github/workflows/sdd.yml")
    ? renderWorkflow(content, gates)
    : content;
}

/** Gate strictness for this run: explicit --gates wins; else the manifest's
 *  recorded choice (a strictness change is an explicit decision, not an
 *  implied re-render); else warn-only (the default, backwards compatible). */
export function gatesOf(root: string, explicit?: GatesStrictness): GatesStrictness {
  if (explicit !== undefined) return explicit;
  const recorded = readManifest(root).manifest?.stages["2"]?.gates;
  return recorded ?? "warn-only";
}

export const TEMPLATE_DIR = join(import.meta.dirname, "..", "templates");

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
  /** Why the check failed — failing command + stderr excerpt (first failure, truncated). */
  error: string | null;
  /** A tool of the verification command was not installed (exit 127) — not a build failure. */
  missingTool: string | null;
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
function declaredNpmLifecycle(root: string): { build: string | null; test: string | null } {
  const pkg = packageJsonOf(root);
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {};
  // Prefix-family rule, one source of truth with the audit's scriptKey and
  // the CI template's declared-commands job: a key matches by exact name OR a
  // `family:` variant (build:prod, check:metadata). The three recognizers
  // must agree or the audit credits commands the verification never runs
  // (a check:metadata credited as build:true while transform reports
  // "no command declared").
  const familyKey = (families: string[]): string | null =>
    Object.keys(scripts).find((k) => families.some((f) => k === f || k.startsWith(`${f}:`))) ?? null;
  const build = familyKey(["build", "compile", "typecheck", "check", "verify"]);
  const test = familyKey(["test", "spec"]);
  return { build: build ? `npm run ${build}` : null, test: test ? `npm run ${test}` : null };
}

/** go test minus E2E suites — test/e2e dirs hold integration specs that need
 *  live infrastructure and would make the gate permanently red (a repo's
 *  `go test ./...` would sweep 60 Ginkgo specs into the gate). For repos
 *  without a test/e2e dir the pipeline is behavior-identical to
 *  `go test ./...`. One source of truth: stackLifecycle (local verification
 *  + audit --verify), the go workflow template's declared-commands job, and
 *  the generated go-test hook entry all carry this exact string (parity test
 *  pins the template). Defined in stacks.ts — the shared lifecycle table
 *  (spec 0015 slice 2). */

/**
 * Per-stack lifecycle commands (decision #13): node stays package.json-declared;
 * python/go/java use fixed standard commands, verified by the CI hard gate —
 * the same trust model as package.json scripts (the gate actually runs them).
 */
export function stackLifecycle(root: string): { build: string | null; test: string | null } {
  const stack = primaryStack(root);
  if (stack === "go") return { build: "go build ./...", test: GO_TEST_COMMAND };
  if (stack === "rust") return { build: "cargo build", test: "cargo test" };
  if (stack === "python") return { build: null, test: "python3 -m unittest discover -q || [ $? -eq 5 ]" };
  if (stack === "java") {
    if (hasAny(root, ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"])) {
      return { build: existsSync(join(root, "gradlew")) ? "./gradlew build" : "gradle build", test: null };
    }
    return { build: null, test: existsSync(join(root, "mvnw")) ? "./mvnw -q -B test" : "mvn -q -B test" };
  }
  return declaredNpmLifecycle(root);
}

/** Verification tri-state (spec 0002/0013): a timeout or a missing tool is
 *  `unverifiable` — the build's state is undetermined, never "already
 *  failing". */
export type VerifyState = "ok" | "failed" | "unverifiable";

interface CommandResult {
  ok: boolean;
  state: VerifyState;
  /** Failing command + stderr excerpt (truncated) — null when the command passed. */
  error: string | null;
  /** Tool that could not be found — a missing local tool is NOT a failing
   *  build. Detected anywhere in the stderr (a `sh: pnpm: command not found`
   *  inside an npm script names pnpm), falling back to the command's first
   *  word. */
  missingTool: string | null;
}

interface VerifyOptions {
  /** Kill the verification after this many ms (0/unset = never — a long build
   *  is not a hang; the heartbeat is the only feedback by default). */
  timeoutMs?: number;
  /** `--verify-command` override: verifies exactly this command instead of the
   *  lifecycle family (a composite monorepo build may never converge). */
  command?: string;
}

/** Shared failure classifier (transform + audit — one source of truth, spec
 *  0015 command-source rule): a missing binary is tool-missing, not a broken
 *  build. **Exit 127 is the shell's command-not-found convention** — that
 *  alone classifies as `unverifiable` (npm propagates the inner sh's 127,
 *  whether the shell is bash (`sh: x: command not found`) or dash
 *  (`/bin/sh: 1: x: not found`)); the stderr text only names the tool for a
 *  better message. A "No such file or directory" WITHOUT exit 127 is NOT
 *  tool-missing — `cd /nonexistent` (exit 2) and `cp: cannot stat 'x'`
 *  (exit 1) are real build failures (review round, 2026-08-16; CI caught the
 *  dash format: macOS's bash masked it locally). A timeout is
 *  `unverifiable` — never a real failure. */
export function classifyFailure(
  code: number | null,
  stderr: string,
  timedOut: boolean,
): { state: "failed" | "unverifiable"; rawTool: string | null; cause: string } {
  if (timedOut) return { state: "unverifiable", rawTool: null, cause: "timed out" };
  if (code !== 127) return { state: "failed", rawTool: null, cause: `exit ${code ?? "?"}` };
  const s = stderr.trim();
  // bash: `sh: pnpm: command not found` · dash: `/bin/sh: 1: pnpm: not found`
  // (line-numbered) or `sh: pnpm: not found` (POSIX without line numbers).
  const tool =
    /sh: (\S+): command not found/.exec(s)?.[1] ??
    /(?:^|\n)\s*[^\s:]+: \d+: ([^\s:]+): not found/.exec(s)?.[1] ??
    /(?:^|\n)\s*[^\s:]+: ([^\s:]+): not found/.exec(s)?.[1] ??
    null;
  return { state: "unverifiable", rawTool: tool, cause: "exit 127" };
}

/** Top-level `&&` / `;` segments of a composite command — run one at a time
 *  so the heartbeat names the current sub-step (a monorepo root build chains
 *  tsc + tsdown + web; "step 2/3: tsc -b" tells where it is). Quote-aware:
 *  a quoted `&&` or `;` (e.g. `grep "a && b" f`) is data, never a separator
 *  (review round, 2026-08-16). */
export function splitSteps(command: string): string[] {
  const steps: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || ch === ";") {
      if (current.trim().length > 0) steps.push(current.trim());
      current = "";
      if (ch === "&") i++;
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) steps.push(current.trim());
  return steps;
}

const MONOREPO_SIGNALS = ["pnpm-workspace.yaml", "lerna.json", "rush.json"] as const;

/** Workspace signals at the repo root (pnpm-workspace.yaml / lerna.json /
 *  rush.json) — the root build of such a repo chains the whole graph and can
 *  run for tens of minutes without converging. */
export function monorepoSignalOf(root: string): string | null {
  return MONOREPO_SIGNALS.find((f) => existsSync(join(root, f))) ?? null;
}

function declaredScriptOf(root: string, families: string[]): string | null {
  const pkg = packageJsonOf(root);
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {};
  return Object.keys(scripts).find((k) => families.some((f) => k === f || k.startsWith(`${f}:`))) ?? null;
}

/** The verification command family (transform + audit share it): an explicit
 *  `--verify-command` override wins; a workspace root whose lifecycle is npm
 *  scripts degrades to the lightest trusted declared command (typecheck →
 *  test → lint, first present) — the pnpm-workspace composite build never
 *  converges, and "unverifiable" beats a 30-minute stall. */
export function verifyCommandsOf(root: string, override?: string): string[] {
  if (override !== undefined) return splitSteps(override);
  const { build, test } = stackLifecycle(root);
  const cmds = [build, test].filter((c): c is string => c !== null);
  if (monorepoSignalOf(root) !== null && cmds.some((c) => c.startsWith("npm run"))) {
    const light =
      declaredScriptOf(root, ["typecheck"]) ?? declaredScriptOf(root, ["test"]) ?? declaredScriptOf(root, ["lint"]);
    if (light !== null) return [`npm run ${light}`];
  }
  return cmds;
}

function runCommand(root: string, command: string, opts: VerifyOptions = {}, label?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    // detached: timeout kills the whole command tree, not just the shell —
    // an orphaned `sleep`/build child would otherwise outlive the kill.
    const child = spawn("sh", ["-c", command], { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (d) => (stderr += String(d)));
    // Long builds look hung without feedback — a heartbeat line every 10s
    // (a go test ./... can run >10 minutes with zero output while stage 2
    // applies). The label names the composite command's current sub-step.
    const heartbeat = setInterval(() => {
      process.stderr.write(
        `  ... verification still running (${Math.round((Date.now() - started) / 1000)}s): ${label ?? command}\n`,
      );
    }, 10_000);
    const timer =
      opts.timeoutMs === undefined || opts.timeoutMs <= 0
        ? null
        : setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) {
              try {
                process.kill(-child.pid, "SIGTERM");
              } catch {
                child.kill("SIGTERM");
              }
            }
          }, opts.timeoutMs);
    child.on("close", (code) => {
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      const s = stderr.trim();
      if (code === 0 && !timedOut) return resolve({ ok: true, state: "ok", error: null, missingTool: null });
      // Failure excerpt = FAIL-ish lines + the tail, NOT the head — the head
      // of a long run is downloads/setup; the actual failure is at the end
      // (a report showing "go: downloading …" would cut off the real
      // failures at the tail entirely).
      const lines = s.split("\n");
      const fails = lines.filter((l) => /FAIL|error:|Error:|panic:/i.test(l)).slice(-6);
      const tail = lines.slice(-12);
      const picked = [...new Set([...fails, ...tail])].slice(-12).join("\n");
      const excerpt = picked.length > 400 ? `…${picked.slice(-400)}` : picked;
      const c = classifyFailure(code ?? null, s, timedOut);
      const missingTool = c.rawTool ?? (c.state === "unverifiable" && !timedOut ? command.split(/\s+/)[0] : null);
      const cause = timedOut ? `timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s` : c.cause;
      resolve({ ok: false, state: c.state, error: `${cause}${excerpt ? `: ${excerpt}` : ""}`, missingTool });
    });
  });
}

/** Environment diagnostics for a failed verification — distinguishes an
 *  unbuildable environment (missing node_modules / broken dependency tree)
 *  from a broken repo (spec 0002). Null when nothing diagnosable is found.
 *  `npm ls` runs only when the repo itself has a package.json (never walk up
 *  to a parent project) and is bounded by a 10s timeout (review round,
 *  2026-08-16). */
function envDiagnosticsOf(root: string): string | null {
  const parts: string[] = [];
  parts.push(existsSync(join(root, "node_modules")) ? "node_modules present" : "node_modules MISSING");
  if (!existsSync(join(root, "package.json"))) return parts.join("; ");
  try {
    execFileSync("npm", ["ls", "--depth=0"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch (err) {
    const e = (err ?? {}) as { status?: number; stderr?: Buffer | string; signal?: string };
    const s = String(e.stderr ?? "")
      .trim()
      .split("\n")
      .slice(0, 3)
      .join(" | ");
    parts.push(
      e.signal === "SIGTERM" ? "npm ls: timed out" : s ? `npm ls: ${s}` : `npm ls: failed (exit ${e.status ?? "?"})`,
    );
  }
  return parts.join("; ");
}

async function runDeclared(
  root: string,
  opts: VerifyOptions = {},
): Promise<{
  ok: boolean;
  state: VerifyState;
  keys: string[];
  /** The failing command (for the SKIP escape hint). */
  command: string | null;
  error: string | null;
  missingTool: string | null;
  /** Environment diagnostics (spec 0002) — null when verification passed. */
  envDiag: string | null;
}> {
  const keys = verifyCommandsOf(root, opts.command);
  // The heartbeat labels each command's position in the family
  // ("step 1/2: npm run build"); a --verify-command composite is split into
  // top-level && / ; segments first, so its heartbeat names the current
  // sub-step ("step 2/3: tsc -b") — default lifecycle commands are single
  // spawns (their inner chains live inside npm scripts, not splittable here).
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const label = keys.length > 1 ? `step ${i + 1}/${keys.length}: ${k}` : k;
    const r = await runCommand(root, k, opts, label);
    if (!r.ok) {
      const envDiag = r.state === "unverifiable" ? envDiagnosticsOf(root) : null;
      return {
        ok: false,
        state: r.state,
        keys,
        command: k,
        error: `${k} — ${r.error}`,
        missingTool: r.missingTool,
        envDiag,
      };
    }
  }
  return { ok: true, state: "ok", keys, command: null, error: null, missingTool: null, envDiag: null };
}

export function manifestWithStage(root: string, stage: string, entry: ManifestStage): Record<string, ManifestStage> {
  const mr = readManifest(root);
  const merged: Record<string, ManifestStage> = { ...(mr.present && mr.manifest ? mr.manifest.stages : {}) };
  merged[stage] = entry;
  return merged;
}

/** The pre-M10 universal pre-commit template — kept as the upgrade baseline:
 *  installed bytes equal to it are tool-owned and get upgraded, not conflicted. */
const LEGACY_PRE_COMMIT_TEMPLATE = "pre-commit-config.yaml";

/** Marker header of generated pre-commit configs (spec 0012): installed bytes
 *  carrying it are tool-owned — upgraded by regeneration, never conflicted. */
const GENERATED_PRE_COMMIT_MARKER = "# pre-commit config generated by spooner transform Stage 2";

/** M13: prompt the manual hook install — only when a generated pre-commit
 *  config applies and no hook is installed yet (config ≠ enforcement; the
 *  agent still runs `pre-commit install` per SKILL.md). */
function hookPromptOf(root: string, ecosystem: HookTool, templates: Record<string, string>): string {
  if (ecosystem === "husky" || ecosystem === "lefthook" || ecosystem === "yorkie") return "";
  if (templates[PRE_COMMIT_FILE] === undefined) return "";
  const installed =
    existsSync(join(root, ".git", "hooks", "pre-commit")) || existsSync(join(root, ".git", "hooks", "commit-msg"));
  return installed
    ? ""
    : "; hooks not installed — run: pre-commit install --hook-type pre-commit --hook-type commit-msg";
}

/** Android SDK failures are an environment-config issue, not a broken build —
 *  the report must say so and name the escape hatch: the local java-test hook
 *  can be skipped per commit with SKIP=java-test; the CI hard gate needs
 *  ANDROID_HOME / local.properties (or a setup-android step). */
function androidEnvHint(error: string | null): string {
  return error && /SDK location not found|ANDROID_HOME|local\.properties/i.test(error)
    ? " — Android: this looks like a missing SDK/environment config, not a broken build (set ANDROID_HOME / local.properties and re-run; local commits can proceed with SKIP=java-test)"
    : "";
}

/** The generated pre-commit hook that gates a failing verification command —
 *  the named SKIP escape for the stage-2 report (a pre-existing go test
 *  failure must not block commits with no named escape, while the Android
 *  case has SKIP=java-test). */
function verificationHookIdOf(root: string, command: string): string | null {
  if (/\bgo (build|test)\b/.test(command)) return "go-test";
  if (/\bcargo\b/.test(command)) return "cargo-test";
  if (/\b(mvn|gradle)\b/.test(command)) return "java-test";
  if (/python3 -m unittest/.test(command)) return pytestPresent(root) ? "pytest" : null;
  const m = command.match(/^npm run (\S+)/);
  if (m) return m[1] === "test" || m[1] === "spec" ? "test" : "typecheck";
  return null;
}

/** Escape hint follows the ACTIVE hook tool (spec 0010 revision): pre-commit
 *  repos skip per-hook with SKIP=<id>; lefthook has no SKIP env var —
 *  LEFTHOOK=0 runs its hooks with config only; husky/yorkie have no stable
 *  skip env, so no hint (an invented one would mislead). */
function skipEscapeHint(root: string, command: string | null, ecosystem: HookTool): string {
  if (!command) return "";
  if (ecosystem === "lefthook")
    return " — local commits can proceed with LEFTHOOK=0 (lefthook skips its hooks; the CI hard gate still verifies the real build)";
  if (ecosystem !== "pre-commit" && ecosystem !== "none") return "";
  const id = verificationHookIdOf(root, command);
  return id
    ? ` — local commits can proceed with SKIP=${id} (pre-commit skip; the CI hard gate still verifies the real build)`
    : "";
}

export async function applyStage2(
  root: string,
  dryRun: boolean,
  ciOverride?: string,
  verifyOpts: VerifyOptions = {},
  gatesArg?: GatesStrictness,
): Promise<Stage2Result> {
  const gates = gatesOf(root, gatesArg);
  const templates = stage2Templates(root, ciOverride);
  const plans: Stage2FilePlan[] = Object.entries(templates).map(([file, tpl]) => {
    const target = join(root, file);
    if (!existsSync(target)) return { file, action: "write" };
    const current = readFileSync(target, "utf8");
    if (current === stage2Content(root, file, tpl, gates)) return { file, action: "keep" };
    // M10 legacy upgrade: bytes from the pre-M10 universal template, or any
    // generated config carrying the marker header (M12), are tool-owned.
    if (
      file === PRE_COMMIT_FILE &&
      (current === templateContent(LEGACY_PRE_COMMIT_TEMPLATE) || current.includes(GENERATED_PRE_COMMIT_MARKER))
    )
      return { file, action: "write" };
    // A workflow installed by the tool is tool-owned across strictness
    // levels: this stack's template bytes in either render rewrite to the
    // current choice (a strictness switch is a re-render, not a user-edit
    // conflict — spec 0008 question 5). Other stacks' bytes stay conflicts
    // (the wrong-stack hint below keeps its delete-and-re-run UX).
    if (file === ".github/workflows/ai-native.yml" && tpl !== GENERATED) {
      const content = templateContent(tpl);
      if (current === content || current === renderWorkflow(content, "hard")) return { file, action: "write" };
      // Tool-owned across version bumps — but ONLY for the stale baked
      // EXPECTED: normalize the installed version and compare bytes. Any
      // other divergence (a user body edit under an intact header) is the
      // user's file — conflict (the marker alone would overwrite body edits
      // silently; the "user-edited stays conflict" guarantee must hold
      // beyond full-file replacement).
      const stackName = tpl.replace(/^ci-workflow-/, "").replace(/\.yml$/, "");
      if (current.includes(generatedWorkflowMarker(stackName))) {
        const normalized = current.replace(/EXPECTED = "\d+\.\d+\.\d+"/, () => `EXPECTED = "${TOOL_VERSION}"`);
        if (normalized === content || normalized === renderWorkflow(content, "hard")) return { file, action: "write" };
      }
    }
    return { file, action: "conflict" };
  });
  const toWrite = plans.filter((p) => p.action === "write");
  const conflicts = plans.filter((p) => p.action === "conflict");
  // The verification family follows the override/monorepo rules (spec 0002) —
  // the report's command must match what runDeclared actually runs.
  const command = verifyCommandsOf(root, verifyOpts?.command).join(" && ") || null;

  // Unsupported-stack notice (decision #13): cross-stack gates only, no workflow.
  const stack = primaryStack(root);
  const detected = detect(root).stacks;
  const notice =
    stack !== null
      ? null
      : detected.length > 0
        ? `stack ${detected.join("/")}: transform not supported yet — audit works; supported stacks: node/python/go/java/rust (cross-stack gates installed, CI workflow skipped)`
        : "no recognized stack — cross-stack gates installed, CI workflow skipped (supported stacks: node/python/go/java/rust)";
  // A transform-unsupported stack has no lifecycle-verified CI (spec 0014).
  // The verify phrase must say "not run for this stack" — "none declared"
  // would contradict the audit credit (an xcodebuild lifecycle scored
  // agents-commands while stage 2 reported "none declared"). Only stacks the
  // audit actually traces (its stackCommandSources branches:
  // apple/c-cpp/zig/dart-flutter/php) get the "audit-traced" claim —
  // unity/ruby/swift/dotnet/harmonyos have no traced lifecycle at all.
  const TRACED_UNSUPPORTED = ["apple", "c/cpp", "zig", "dart/flutter", "php"];
  const unsupportedStacks = stack === null && detected.length > 0 ? detected.join("/") : null;
  // Per-stack phrasing for mixed combos: apple+ruby must not claim "no
  // canonical lifecycle" while the audit traces xcodebuild.
  const tracedSubset = detected.filter((s) => TRACED_UNSUPPORTED.includes(s));
  const untracedSubset = detected.filter((s) => !TRACED_UNSUPPORTED.includes(s));
  const unsupportedTracedPhrase =
    tracedSubset.length === 0
      ? "no canonical lifecycle"
      : untracedSubset.length === 0
        ? "its lifecycle is audit-traced, not verified"
        : `${tracedSubset.join("/")} lifecycle audit-traced, not verified; ${untracedSubset.join("/")} has no canonical lifecycle`;

  // Non-GitHub workflow skip notice (spec 0008): local CI files or the origin
  // remote host (greenfield — no CI files) decide; an explicit --ci override
  // is reported the same way. The workflow would be a dead file elsewhere.
  const platformNotice =
    stack !== null && !templates[".github/workflows/ai-native.yml"] ? workflowSkipReason(root, ciOverride) : null;

  // Hook-tool skip notice (M10, spec 0010): husky/lefthook/yorkie ecosystems
  // keep their own hooks — the generated pre-commit config would be a foreign
  // gate file. The removal hint names the active form (a dead husky
  // dependency never reaches here — dead deps install the gates).
  const ecosystem = hookToolEcosystem(root);
  const hookNotice =
    ecosystem === "husky" || ecosystem === "lefthook" || ecosystem === "yorkie"
      ? `pre-commit config skipped: detected ${ecosystem} hook ecosystem — keep your existing git hooks (${
          ecosystem === "husky"
            ? existsSync(join(root, ".husky"))
              ? "delete .husky"
              : "remove the husky field from package.json"
            : ecosystem === "yorkie"
              ? "remove the yorkie dependency from package.json"
              : "delete lefthook.yml"
        } and re-run to install the generated pre-commit gates)${
          ecosystem === "lefthook"
            ? "; commitlint local gate: merge templates/lefthook-commit-msg.yml into lefthook.yml and run lefthook install (see SKILL.md)"
            : ""
        }`
      : null;

  // Wrong-stack workflow hint: installed bytes match a different stack's template.
  const workflowFile = ".github/workflows/ai-native.yml";
  let wrongStackHint: string | null = null;
  if (stack && templates[workflowFile]) {
    const target = join(root, workflowFile);
    if (existsSync(target)) {
      const installed = readFileSync(target, "utf8");
      if (installed !== templateContent(templates[workflowFile])) {
        const other = Object.entries(STAGE2_WORKFLOWS).find(
          ([s, t]) => s !== stack && installed === templateContent(t),
        );
        if (other)
          wrongStackHint = `installed workflow targets the ${other[0]} stack — delete ${workflowFile} and re-run to install the ${stack} workflow`;
      }
    }
  }
  // Markdownlint skip notice: a pre-existing repo config governs the gate
  // (cli2 merges configs — the generated one would be diluted). The hint names
  // the cleanup for both directions (foreign config present / generated one
  // already installed from a previous run).
  const mdForeign = foreignMarkdownlintConfigOf(root);
  const mdNotice =
    mdForeign === null
      ? null
      : existsSync(join(root, ".markdownlint-cli2.yaml"))
        ? `markdownlint config skipped: detected ${mdForeign} — keeping your markdownlint config (the gate follows it; remove the generated .markdownlint-cli2.yaml to avoid cli2 merging both)`
        : `markdownlint config skipped: detected ${mdForeign} — keeping your markdownlint config (the gate follows it; delete ${mdForeign} and re-run to install the generated config)`;
  // Commitlint alias skip: the repo's own commitlint config governs the gate
  // (an installed .commitlintrc.json would shadow it via cosmiconfig order).
  const clForeign = foreignCommitlintConfigOf(root);
  const clNotice =
    clForeign === null
      ? null
      : `commitlint config skipped: detected ${clForeign} — keeping your commitlint config (the commit-msg hook uses it; delete ${clForeign} and re-run to install the generated one)`;
  const extra = [notice, platformNotice, wrongStackHint, hookNotice, mdNotice, clNotice].filter(Boolean).join("; ");

  if (dryRun) {
    return {
      stage: 2,
      applied: false,
      dryRun: true,
      files: plans,
      buildCheck: { command, before: null, after: null, error: null, missingTool: null },
      manifestUpdated: false,
      message: `dry-run: ${toWrite.length} file(s) to write, ${conflicts.length} conflict(s), ${plans.length - toWrite.length - conflicts.length} already installed; ${
        command
          ? `verification command: ${command}`
          : unsupportedStacks
            ? `verification: not run (stack ${unsupportedStacks} is transform-unsupported — ${unsupportedTracedPhrase})`
            : "verification command: none declared"
      }${extra ? `; ${extra}` : ""}${hookPromptOf(root, ecosystem, templates)}`,
    };
  }

  // Local verification runs the full declared family (incl. check/verify —
  // local tooling like pre-commit exists here); the CI gate template runs
  // self-contained families only (a clean CI checkout lacks that tooling).
  // A failure here names rollback or pre-existing, never fakes green.
  const beforeRun = command ? await runDeclared(root, verifyOpts) : null;
  const before = beforeRun ? beforeRun.ok : null;
  for (const p of toWrite) {
    mkdirSync(join(root, p.file, ".."), { recursive: true });
    writeFileSync(join(root, p.file), stage2Content(root, p.file, templates[p.file], gates), "utf8");
  }
  const afterRun = command ? await runDeclared(root, verifyOpts) : null;
  const after = afterRun ? afterRun.ok : null;
  // first failure carries the reason (stderr excerpt + exit code)
  const buildError = beforeRun?.error ?? afterRun?.error ?? null;
  const missingTool = beforeRun?.missingTool ?? afterRun?.missingTool ?? null;
  // the manifest is the ledger: restore it even when no files are written
  // (a deleted .ai-native.yml must not be a dead end for the drift gate's
  // "run transform stage 2" remediation — and check's no-manifest suggestion)
  const manifestMissing = !readManifest(root).present;
  const manifestUpdated = toWrite.length > 0 || manifestMissing;

  if (manifestUpdated) {
    writeManifest(
      root,
      manifestWithStage(root, "2", {
        date: new Date().toISOString().slice(0, 10),
        warnOnly: true,
        // strictness is a property of the installed workflow; no-workflow
        // mode records nothing (spec 0008: manifest = what was installed)
        ...(templates[".github/workflows/ai-native.yml"] !== undefined ? { gates } : {}),
        templateVersion: TOOL_VERSION,
        files: Object.keys(templates),
      }),
    );
  }

  let message: string;
  const afterState = afterRun?.state; // "ok" | "failed" | "unverifiable"
  const beforeState = beforeRun?.state; // "ok" | "failed" | "unverifiable" | null
  if (toWrite.length === 0 && conflicts.length === 0) {
    message =
      (manifestMissing
        ? "stage 2 files already installed; manifest restored"
        : "stage 2 already installed (no changes)") + (extra ? `; ${extra}` : "");
  } else if (after === false) {
    const written = toWrite.map((p) => p.file).join(", ");
    const diag = afterRun?.envDiag ?? beforeRun?.envDiag ?? null;
    const diagPhrase = diag ? `; environment: ${diag}` : "";
    // Tri-state (spec 0002/0013): a timeout is unverifiable — never
    // "ALREADY failing before apply"; a real failure names rollback or
    // pre-existing; tool-missing is not a failing build.
    const extraPhrase = extra ? `; ${extra}` : "";
    if (afterState === "unverifiable" && missingTool) {
      message = `stage 2 applied: ${written} written; build verification could not run — ${missingTool} is not installed (exit 127: command not found) — install the tool and re-run; a missing local tool is not a failing build (hooks stay installed; CI hard gates will verify the real build)${extraPhrase}${diagPhrase}`;
    } else if (afterState === "unverifiable") {
      message = `stage 2 applied: ${written} written; verification could not complete (${buildError ?? "timed out"}) — the build's state is undetermined, not a failing build; re-run with a lighter --verify-command (e.g. an npm typecheck/test script) or raise --verify-timeout${extraPhrase}${diagPhrase}`;
    } else if (beforeState === "failed") {
      // "installed hooks are hard gates" is pre-commit's truth — a kept
      // lefthook/husky repo installed no new hooks, so it reports its own
      // state instead (spec 0010 revision).
      const gatePhrase =
        ecosystem === "pre-commit" || ecosystem === "none"
          ? "installed hooks are hard gates (commits stay blocked until the build is fixed)"
          : `your kept ${ecosystem} hooks stay as-is; the CI hard gate verifies the real build`;
      message = `stage 2 applied: build was ALREADY failing before apply (pre-existing${buildError ? ` — ${buildError}` : ""}); ${written} written; verification still failing after — ${gatePhrase}${skipEscapeHint(root, beforeRun?.command ?? afterRun?.command ?? null, ecosystem)}${androidEnvHint(buildError)}${extraPhrase}${diagPhrase}`;
    } else {
      message = `stage 2 applied but build verification FAILED after — ${buildError ?? "unknown error"}; rollback: git restore ${written}${extraPhrase}${diagPhrase}`;
    }
  } else {
    const parts: string[] = [];
    if (toWrite.length > 0) parts.push(`${toWrite.length} file(s) written`);
    if (conflicts.length > 0)
      parts.push(
        `${conflicts.length} conflict(s) kept (existing config differs — not overwritten: ${conflicts.map((c) => c.file).join(", ")})`,
      );
    if (before === null)
      parts.push(
        unsupportedStacks
          ? `no verification run (stack ${unsupportedStacks} is transform-unsupported — ${unsupportedTracedPhrase})`
          : "no build/test command declared — nothing to verify",
      );
    else if (beforeState === "failed")
      parts.push(
        `build was failing before apply (pre-existing${buildError ? ` — ${buildError}` : ""}); green after (${command})`,
      );
    else if (beforeState === "unverifiable")
      parts.push(`could not verify before apply (${beforeRun?.error ?? "timed out"}); green after (${command})`);
    else parts.push(`build green before+after (${command})`);
    message = `stage 2 applied: ${parts.join("; ")}${extra ? `; ${extra}` : ""}${hookPromptOf(root, ecosystem, templates)}${manifestUpdated ? "; manifest updated" : ""}`;
  }

  return {
    stage: 2,
    applied: toWrite.length > 0,
    dryRun: false,
    files: plans,
    buildCheck: { command, before, after, error: buildError, missingTool },
    manifestUpdated,
    message,
  };
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
    return (
      readFileSync(join(root, "Makefile"), "utf8")
        .split("\n")
        // Same rule as audit's makefileTargets — real targets only (leading
        // alpha + `:(?!=)`) so VAR := assignments and .PHONY never become
        // phantom commands.
        .filter((l) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\s*:(?!=)/.test(l))
        .map((l) => l.split(":")[0].trim())
    );
  } catch {
    return [];
  }
}

/**
 * Stack lifecycle commands (decision #13): standard commands traced to build
 * files, verified by the CI hard gate — same trust model as package.json scripts.
 */
function stackCommandsOf(root: string): { command: string; purpose: string }[] {
  const stacks = detect(root).stacks;
  const out: { command: string; purpose: string }[] = [];
  // Canonical static lifecycles come from the shared table (spec 0015
  // slice 2 — single source with the audit's command-source check).
  for (const stack of Object.keys(STACK_COMMANDS)) {
    if (stacks.includes(stack)) out.push(...STACK_COMMANDS[stack]);
  }
  // Dynamic lifecycles stay here: node declared scripts, java gradle/maven,
  // php phpunit presence (the audit's stackCommandSources parity — the
  // generated contract must not say "None declared" while the audit credits
  // it; pitfall class 3, spec 0015 slice 1). Composer scripts stay
  // declared-scripts-only (no invention).
  if (stacks.includes("java")) {
    if (hasAny(root, ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]))
      out.push({ command: "gradle build", purpose: "build + test" });
    else
      out.push({ command: existsSync(join(root, "mvnw")) ? "./mvnw -q -B test" : "mvn -q -B test", purpose: "test" });
  }
  // php: mirror the audit's dual signal (phpTestSourceOf) — phpunit.xml(.dist)
  // OR a phpunit/phpunit declaration in composer.json require-dev; the
  // generated contract must not say "None declared" while the audit credits
  // the command (composer-declared phpunit credited by the audit must not be
  // missing from the command table). Composer scripts stay
  // declared-scripts-only (no invention).
  if (
    stacks.includes("php") &&
    (existsSync(join(root, "phpunit.xml")) ||
      existsSync(join(root, "phpunit.xml.dist")) ||
      (existsSync(join(root, "composer.json")) &&
        readFileSync(join(root, "composer.json"), "utf8").includes("phpunit/phpunit")))
  ) {
    out.push({ command: "phpunit", purpose: "test" });
  }
  return out;
}

/**
 * Deterministic AGENTS.md generation: every command traces to a real file
 * (package.json scripts / Makefile). Nothing is invented — the killer gate.
 */
export function generateAgentsMd(root: string): string {
  const pkg = packageJsonOf(root);
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {};
  const stacks = detect(root).stacks;
  const name = typeof pkg?.name === "string" && pkg.name ? pkg.name : basename(resolve(root));
  const description = typeof pkg?.description === "string" ? pkg.description : null;
  const scriptKeys = Object.keys(scripts).sort();
  const makeTargets = makefileTargetsOf(root);
  const stackCmds = stackCommandsOf(root);
  /** Stack-specific advisory copy — not command claims (the commands table
   *  above is the only traceable part); each line references commands that
   *  table already declares for that stack. */
  const stackConventions: Record<string, string> = {
    node: "- Node: prefer `npm run` scripts for anything agent-run (the gates verify them)",
    python: "- Python: install dependencies via pip inside a virtualenv (never system-wide)",
    go: "- Go: run `gofmt` and `go vet` before committing",
    rust: "- Rust: run `cargo fmt` and `cargo clippy` before committing",
    java: "- Java: prefer the wrapper (`mvnw`/`gradlew`) when present",
  };
  const lines: string[] = [
    `# ${name} — agent contract`,
    "",
    "> Generated by spooner transform Stage 3. Every command below is",
    "> traceable to a real file (package.json scripts / Makefile / the",
    "> stack's lifecycle manifest) — nothing is invented.",
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
  if (scriptKeys.length === 0 && makeTargets.length === 0 && stackCmds.length === 0) {
    // Distinguish dynamic-lifecycle stacks (node/java/php — a canonical
    // lifecycle exists but nothing is declared) from no-lifecycle stacks
    // (unity/ruby/swift/dotnet/harmonyos — documented ceiling; "node has no
    // canonical lifecycle" would be factually wrong — node's lifecycle IS
    // declared scripts, just absent here).
    const dynamicOnly = stacks.length > 0 && stacks.every((s) => DYNAMIC_LIFECYCLE_STACKS.includes(s));
    // Per-stack unlock hint — package.json scripts only make sense for node
    // (a php-only repo must not get "add e.g. package.json scripts").
    const unlockHint = stacks
      .flatMap((s) =>
        s === "node"
          ? ["package.json scripts"]
          : s === "php"
            ? ["composer.json scripts"]
            : s === "java"
              ? ["Maven/Gradle build files"]
              : [],
      )
      .join(" or ");
    lines.push(
      dynamicOnly
        ? `- None declared — no ${stacks.join("/")} scripts/commands found (add e.g. ${unlockHint} to unlock the gates).`
        : stacks.length > 0
          ? `- None declared — ${stacks.join("/")} has no canonical CLI lifecycle command to document (documented ceiling; the audit under-scores honestly).`
          : "- None declared — add real build/test commands and document them here to unlock the gates.",
      "",
    );
  } else {
    lines.push("| Command | Purpose |", "|---|---|");
    for (const k of scriptKeys) lines.push(`| \`npm run ${k}\` | ${k} |`);
    for (const t of makeTargets) lines.push(`| \`make ${t}\` | Makefile target |`);
    for (const c of stackCmds) lines.push(`| \`${c.command}\` | ${c.purpose} |`);
    lines.push("");
  }
  lines.push("## Conventions", "");
  for (const s of stacks) {
    const c = stackConventions[s];
    if (c) lines.push(c);
  }
  lines.push("- Follow the repo's existing conventions; keep the build green.", "");
  return lines.join("\n");
}

export function applyStage3(root: string, dryRun: boolean): Stage3Result {
  const generated = generateAgentsMd(root);
  const agentsPath = join(root, "AGENTS.md");
  const claudePath = join(root, "CLAUDE.md");

  const agentsAction: Stage3FilePlan = (() => {
    // lstatSync first — readFileSync/writeFileSync follow symlinks: an
    // AGENTS.md that is a symlink to a marker-carrying target would be
    // written THROUGH the link, overwriting the real target file (stage 3
    // without the stage-4 lstat guard — the same class as stage-4 symlink
    // write-through pollution; the M12 marker check makes the write-through
    // path reachable). Symlink AGENTS.md → conflict, never write.
    let agentsStat: ReturnType<typeof lstatSync> | null = null;
    try {
      agentsStat = lstatSync(agentsPath);
    } catch {
      agentsStat = null; // absent
    }
    if (agentsStat === null) return { file: "AGENTS.md", action: "write" };
    if (agentsStat.isSymbolicLink()) return { file: "AGENTS.md", action: "conflict" };
    const current = readFileSync(agentsPath, "utf8");
    if (current === generated) return { file: "AGENTS.md", action: "keep" };
    // tool-owned marker (M12 rule): stage 4 appended the SDD convention, so
    // bytes never match again — the tool must not lock itself out of
    // regeneration
    if (current.includes("Generated by spooner transform Stage 3")) return { file: "AGENTS.md", action: "write" };
    return { file: "AGENTS.md", action: "conflict" };
  })();

  const claudeAction: Stage3FilePlan = (() => {
    // lstatSync (not existsSync — it follows links and hides broken ones)
    let claudeStat: ReturnType<typeof lstatSync> | null = null;
    try {
      claudeStat = lstatSync(claudePath);
    } catch {
      claudeStat = null; // absent
    }
    if (claudeStat === null) return { file: "CLAUDE.md", action: "link" };
    if (claudeStat.isSymbolicLink()) {
      try {
        if (readlinkSync(claudePath) === "AGENTS.md") return { file: "CLAUDE.md", action: "keep" };
      } catch {
        /* unreadable link — fall through to the content check */
      }
      let content = "";
      try {
        content = readFileSync(claudePath, "utf8");
      } catch {
        // broken symlink / unreadable target: never crash
        // stage 3 — treat as conflict, the agent decides
        return { file: "CLAUDE.md", action: "conflict" };
      }
      return /@AGENTS\.md|AGENTS\.md/i.test(content)
        ? { file: "CLAUDE.md", action: "keep" }
        : { file: "CLAUDE.md", action: "conflict" };
    }
    let content = "";
    try {
      content = readFileSync(claudePath, "utf8");
    } catch {
      return { file: "CLAUDE.md", action: "conflict" };
    }
    return /@AGENTS\.md|AGENTS\.md/i.test(content)
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

  if (agentsAction.action === "write") {
    // stage 4 appended the SDD convention after a previous stage-3 generation;
    // regenerating must not silently drop it (a re-run would remove the SDD
    // section with no notice). Re-append when the old
    // content carried the convention — same detection as stage 4's
    // "already-present" check, so the re-run stays idempotent.
    let out = generated;
    try {
      const prev = readFileSync(agentsPath, "utf8");
      if (/\bspec\b|spec-driven|\bSDD\b(?!-)/i.test(prev)) {
        out = `${generated.replace(/\s+$/, "")}\n\n${SDD_CONVENTION}`;
      }
    } catch {
      /* absent — plain generation */
    }
    writeFileSync(agentsPath, out, "utf8");
  }
  // Deterministic across platforms: when AGENTS.md is
  // a conflict (user file / symlink), do NOT create the CLAUDE.md link — the
  // stage is not applied. A case-insensitive FS (macOS APFS) must not behave
  // differently from a case-sensitive one (Linux CI) just because a lowercase
  // target file happens to alias CLAUDE.md.
  if (agentsAction.action !== "conflict" && claudeAction.action === "link") {
    if (process.platform === "win32") writeFileSync(claudePath, "@AGENTS.md\n", "utf8");
    else symlinkSync("AGENTS.md", claudePath);
  }

  const manifestUpdated =
    agentsAction.action === "write" || (agentsAction.action !== "conflict" && claudeAction.action === "link");
  if (manifestUpdated) {
    writeManifest(
      root,
      manifestWithStage(root, "3", {
        date: new Date().toISOString().slice(0, 10),
        templateVersion: TOOL_VERSION,
        files: ["AGENTS.md", "CLAUDE.md"],
      }),
    );
  }

  const conflicts = plans.filter((f) => f.action === "conflict");
  let message: string;
  if (!manifestUpdated && conflicts.length === 0) {
    message = "stage 3 already installed (no changes)";
  } else if (conflicts.length > 0) {
    // M13: name the user-written file and the generated alternative, so
    // "applied" never reads as "your AGENTS.md was upgraded".
    const agentsConflict = conflicts.find((f) => f.file === "AGENTS.md");
    let note = "";
    if (agentsConflict) {
      try {
        if (lstatSync(agentsPath).isSymbolicLink()) {
          note = `; AGENTS.md is a symlink to ${readlinkSync(agentsPath)} — NOT overwritten (writing through it would modify the target); decide the contract's ownership`;
        } else {
          note = `; existing AGENTS.md is user-written (${readFileSync(agentsPath, "utf8").split("\n").length} lines); the generated contract is ${generated.split("\n").length} lines of real commands — keep yours or merge`;
        }
      } catch {
        note = "; existing AGENTS.md differs — keep yours or merge";
      }
    }
    message = `stage 3 applied: ${manifestUpdated ? "files written; " : ""}conflict(s) kept (not overwritten: ${conflicts.map((c) => c.file).join(", ")})${note}`;
  } else {
    const agents = agentsAction.action === "write" ? `written (${generated.split("\n").length} lines)` : "kept";
    const claude =
      claudeAction.action === "link"
        ? process.platform === "win32"
          ? "@AGENTS.md import written"
          : "symlinked to AGENTS.md"
        : "kept";
    message = `stage 3 applied: AGENTS.md ${agents}; CLAUDE.md ${claude}; manifest updated`;
  }
  return { stage: 3, applied: manifestUpdated, dryRun: false, files: plans, manifestUpdated, message };
}

// --- stage 4: SDD adoption ---------------------------------------------------------

/** Install path → template file. */
export const STAGE4_TEMPLATES: Record<string, string> = {
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
  agentsSdd: { plan: "append" | "already-present" | "no-agents-file" | "symlink"; appended: boolean; target?: string };
  manifestUpdated: boolean;
  message: string | null;
}

export function applyStage4(root: string, dryRun: boolean, ciOverride?: string): Stage4Result {
  const templates = stage4Templates(root, ciOverride);
  const plans: Stage2FilePlan[] = Object.entries(templates).map(([file, tpl]) => {
    const target = join(root, file);
    if (!existsSync(target)) return { file, action: "write" };
    return readFileSync(target, "utf8") === templateContent(tpl)
      ? { file, action: "keep" }
      : { file, action: "conflict" };
  });
  const toWrite = plans.filter((p) => p.action === "write");
  const conflicts = plans.filter((p) => p.action === "conflict");

  const agentsPath = join(root, "AGENTS.md");
  let agentsSdd: Stage4Result["agentsSdd"] | undefined;
  // Symlink AGENTS.md first (an upstream AGENTS.md → CLAUDE.md, the reverse
  // of spooner's convention — readFileSync/writeFileSync follow the link, so
  // appending would write the SDD convention into the real target file).
  // Never write through a link: the agent decides where the convention
  // belongs.
  try {
    const st = lstatSync(agentsPath);
    if (st.isSymbolicLink()) {
      agentsSdd = { plan: "symlink", appended: false, target: readlinkSync(agentsPath) };
    }
  } catch {
    /* absent or unreadable — fall through to the content checks */
  }
  if (!agentsSdd) {
    if (!existsSync(agentsPath)) {
      agentsSdd = { plan: "no-agents-file", appended: false };
    } else if (/\bspec\b|spec-driven|\bSDD\b(?!-)/i.test(readFileSync(agentsPath, "utf8"))) {
      agentsSdd = { plan: "already-present", appended: false };
    } else {
      agentsSdd = { plan: "append", appended: false };
    }
  }

  if (dryRun) {
    const agentsPlan =
      agentsSdd.plan === "append"
        ? "append"
        : agentsSdd.plan === "already-present"
          ? "already present"
          : agentsSdd.plan === "symlink"
            ? `symlink to ${agentsSdd.target} — skipped (writing through it would modify the target)`
            : "skipped (no AGENTS.md — run stage 3)";
    const sddSkip = templates[".github/workflows/sdd.yml"] === undefined ? workflowSkipReason(root, ciOverride) : null;
    return {
      stage: 4,
      applied: false,
      dryRun: true,
      files: plans,
      agentsSdd,
      manifestUpdated: false,
      message: `dry-run: ${toWrite.length} file(s) to write, ${conflicts.length} conflict(s), ${plans.length - toWrite.length - conflicts.length} already installed; AGENTS.md SDD convention: ${agentsPlan}${sddSkip ? `; ${sddSkip} (SDD spec gate)` : ""}`,
    };
  }

  for (const p of toWrite) {
    mkdirSync(join(root, p.file, ".."), { recursive: true });
    writeFileSync(join(root, p.file), templateContent(templates[p.file]), "utf8");
  }
  let appended = false;
  if (agentsSdd.plan === "append") {
    writeFileSync(agentsPath, `${readFileSync(agentsPath, "utf8").replace(/\s+$/, "")}\n\n${SDD_CONVENTION}`, "utf8");
    appended = true;
    agentsSdd = { plan: "append", appended: true };
  }

  const sddSkip = templates[".github/workflows/sdd.yml"] === undefined ? workflowSkipReason(root, ciOverride) : null;
  const manifestUpdated = toWrite.length > 0 || appended;
  if (manifestUpdated) {
    const files = [...Object.keys(templates), ...(appended ? ["AGENTS.md"] : [])];
    writeManifest(
      root,
      manifestWithStage(root, "4", {
        date: new Date().toISOString().slice(0, 10),
        templateVersion: TOOL_VERSION,
        files,
      }),
    );
  }

  let message: string;
  if (agentsSdd.plan === "symlink" && toWrite.length === 0 && conflicts.length === 0 && !appended) {
    // "skipped", not "applied" — nothing was written (the old wording said
    // "applied" while the SDD convention was NOT appended)
    message = `stage 4 skipped: AGENTS.md is a symlink to ${agentsSdd.target} — SDD convention NOT appended (writing through it would modify ${agentsSdd.target})${sddSkip ? `; ${sddSkip} (SDD spec gate)` : ""}`;
  } else if (toWrite.length === 0 && conflicts.length === 0 && !appended && agentsSdd.plan !== "symlink") {
    // symlink excluded — the skip notice must reach the agent even on a
    // re-run ("already installed" would swallow the explanation of why the
    // SDD convention was not appended)
    message = `stage 4 already installed (no changes)${sddSkip ? `; ${sddSkip} (SDD spec gate)` : ""}`;
  } else if (conflicts.length > 0) {
    message = `stage 4 applied: ${toWrite.length > 0 || appended ? "changes written; " : ""}conflict(s) kept (not overwritten: ${conflicts.map((c) => c.file).join(", ")})${sddSkip ? `; ${sddSkip} (SDD spec gate)` : ""}`;
  } else {
    const parts: string[] = [];
    if (toWrite.length > 0) parts.push(`${toWrite.length} file(s) written`);
    if (appended) parts.push("AGENTS.md SDD convention appended");
    if (agentsSdd.plan === "already-present") parts.push("AGENTS.md already declares SDD");
    if (agentsSdd.plan === "no-agents-file") parts.push("AGENTS.md missing — run stage 3 first");
    if (agentsSdd.plan === "symlink")
      parts.push(
        `AGENTS.md is a symlink to ${agentsSdd.target} — SDD convention NOT appended (writing through it would modify ${agentsSdd.target})`,
      );
    if (sddSkip) parts.push(sddSkip + " (SDD spec gate)");
    message = `stage 4 applied: ${parts.join("; ")}${manifestUpdated ? "; manifest updated" : ""}`;
  }
  return { stage: 4, applied: manifestUpdated, dryRun: false, files: plans, agentsSdd, manifestUpdated, message };
}

export interface ManifestConsistency {
  checked: boolean;
  consistent: boolean;
  missing: string[];
}

/** Manifest entries vs actual files — the drift seed for the future check command. */
export function checkConsistency(root: string): ManifestConsistency | null {
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

/** Dotted numeric version compare (mirrors sync.ts's versionLt — kept local to
 *  avoid a transform ↔ sync import cycle). */
function ltVersion(a: string, b: string): boolean {
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

export interface ManifestGateResult {
  ok: boolean;
  missing: string[];
  stale: boolean;
  version: string | null;
}

/** Local commit gate (mirrors the CI drift-gate job's baked EXPECTED
 *  compare): manifest present + files exist + version not stale vs the current
 *  tool. Catches the "stale ledger" failure class locally (local pre-commit
 *  reads the working-tree manifest, CI reads the committed one). */
export function checkManifestGate(root: string): ManifestGateResult {
  const mr = readManifest(root);
  if (!mr.present || !mr.manifest) return { ok: false, missing: [], stale: false, version: null };
  const missing = checkConsistency(root)?.missing ?? [];
  const version = mr.manifest.version;
  const stale = ltVersion(version, TOOL_VERSION);
  return { ok: missing.length === 0 && !stale, missing, stale, version };
}

/** Which transform stage restores a given manifest file (mirrors check.ts). */
function gateStageHint(missing: string[]): number {
  if (missing.some((f) => f.startsWith("docs/sdd") || f.endsWith("sdd.yml"))) return 4;
  if (missing.some((f) => f === "AGENTS.md" || f === "CLAUDE.md")) return 3;
  return 2;
}

// --- stage status -------------------------------------------------------------

function stageStatus(root: string, stage: number, ciOverride?: string): StageReport {
  const files =
    stage === 2
      ? Object.keys(stage2Templates(root, ciOverride))
      : stage === 4
        ? Object.keys(stage4Templates(root, ciOverride))
        : STAGE_FILES[stage];
  const present = files.filter((f) => existsSync(join(root, f)));
  const missing = files.filter((f) => !present.includes(f));
  const status: StageStatus = present.length === 0 ? "not-installed" : missing.length === 0 ? "installed" : "partial";
  return { stage, status, present, missing };
}

async function run(
  root: string,
  stage: number | "all",
  dryRun: boolean,
  ciOverride?: string,
  verifyOpts: VerifyOptions = {},
  gatesArg?: GatesStrictness,
): Promise<TransformReport> {
  const stagesToReport = stage === "all" ? [2, 3, 4] : [stage];
  const mr = readManifest(root);
  let applied = false;
  let message: string | null = null;
  let manifestUpdated: boolean | null = null;
  let files: Stage2FilePlan[] | Stage3FilePlan[] | null = null;
  let buildCheck: BuildCheck | null = null;
  if (stage === 2) {
    const r2 = await applyStage2(root, dryRun, ciOverride, verifyOpts, gatesArg);
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
    const r4 = applyStage4(root, dryRun, ciOverride);
    applied = r4.applied;
    message = r4.message;
    manifestUpdated = r4.manifestUpdated;
    files = r4.files;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    root,
    stage,
    dryRun,
    stages: stagesToReport.map((s) => stageStatus(root, s, ciOverride)),
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
    const detail = r.buildCheck.error ? ` — ${r.buildCheck.error}` : "";
    lines.push(
      `- Build verification (${r.buildCheck.command}): before ${r.buildCheck.before ?? "—"} / after ${r.buildCheck.after ?? "—"}${detail}`,
      "",
    );
  }
  if (r.message) lines.push(r.message, "");
  return lines.join("\n");
}

// --- CLI ------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  root: string;
  stage: number | "all";
  dryRun: boolean;
  format: "json" | "markdown";
  ci: "github" | "gitlab" | "none" | undefined;
  gates: GatesStrictness | undefined;
  verifyTimeoutMin: number | undefined;
  verifyCommand: string | undefined;
} {
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
  const ciRaw = valueOf("--ci");
  const ci: "github" | "gitlab" | "none" | undefined =
    ciRaw === undefined
      ? undefined
      : ciRaw === "github" || ciRaw === "gitlab" || ciRaw === "none"
        ? ciRaw
        : (() => {
            throw new Error(`invalid --ci "${ciRaw}" (expected github, gitlab, none, or omit for auto)`);
          })();
  const gatesRaw = valueOf("--gates");
  const gates: GatesStrictness | undefined =
    gatesRaw === undefined
      ? undefined
      : gatesRaw === "warn-only" || gatesRaw === "hard"
        ? gatesRaw
        : (() => {
            throw new Error(`invalid --gates "${gatesRaw}" (expected warn-only, hard, or omit for auto)`);
          })();
  const verifyTimeoutRaw = valueOf("--verify-timeout");
  const verifyTimeoutMin =
    verifyTimeoutRaw === undefined
      ? undefined
      : (() => {
          const n = Number(verifyTimeoutRaw);
          if (!Number.isFinite(n) || n <= 0)
            throw new Error(`invalid --verify-timeout "${verifyTimeoutRaw}" (expected minutes > 0)`);
          return n;
        })();
  const verifyCommand = valueOf("--verify-command");
  return {
    root: valueOf("--root") ?? process.cwd(),
    stage,
    dryRun: argv.includes("--dry-run"),
    format,
    ci,
    gates,
    verifyTimeoutMin,
    verifyCommand,
  };
}

function assertNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok =
    major > 24 || (major === 24 && minor >= 12) || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  if (!ok) {
    console.error(
      `transform: Node.js >= 22.18 required (native type stripping); found ${process.versions.node}.\n` +
        "Upgrade Node, e.g. via your version manager (nvm install --lts).",
    );
    process.exit(1);
  }
}

// CLI entry: runs only when executed directly (importing must not trigger side effects)
if (isDirectEntry(import.meta.url)) {
  assertNodeVersion();
  void (async () => {
    try {
      const { root, stage, dryRun, format, ci, gates, verifyTimeoutMin, verifyCommand } = parseArgs(
        process.argv.slice(2),
      );
      const verifyOpts: VerifyOptions = {
        ...(verifyTimeoutMin === undefined ? {} : { timeoutMs: verifyTimeoutMin * 60_000 }),
        ...(verifyCommand === undefined ? {} : { command: verifyCommand }),
      };
      const report = await run(root, stage, dryRun, ci, verifyOpts, gates);
      process.stdout.write(format === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
      // applied but the post-apply build check failed → signal rollback
      if (report.applied && report.buildCheck?.after === false) process.exit(1);
      // local commit gate: manifest present + consistent + not stale —
      // mirrors the CI drift-gate job so local pre-commit catches ledger drift
      if (process.argv.includes("--manifest-gate")) {
        const g = checkManifestGate(root);
        if (!g.ok) {
          console.error(
            g.version === null
              ? "manifest gate FAILED: no .ai-native.yml — run transform stage 2 first"
              : g.missing.length > 0
                ? `manifest gate FAILED: missing ${g.missing.join(", ")} — re-run transform stage ${gateStageHint(g.missing)} to restore them`
                : `manifest gate FAILED: manifest v${g.version} < current v${TOOL_VERSION} — run sync to apply the current templates`,
          );
          process.exit(1);
        }
        console.log(`manifest gate: ok (v${g.version})`);
      }
    } catch (err) {
      console.error(`transform: ${(err as Error).message}`);
      process.exit(1);
    }
  })();
}
