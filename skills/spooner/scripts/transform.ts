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
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detect } from "./detect.ts";

const MANIFEST_FILE = ".ai-native.yml";
const SCHEMA_VERSION = 1;
const TOOL_NAME = "spooner";
export const TOOL_VERSION = "0.5.0";

/** Output files per stage (pinned in specs/0002 §per-stage outputs). */
const STAGE_FILES: Record<number, string[]> = {
  2: [".commitlintrc.json", ".pre-commit-config.yaml", ".markdownlint-cli2.yaml", ".github/workflows/ai-native.yml"],
  3: ["AGENTS.md", "CLAUDE.md"],
  4: ["docs/sdd/spec.md", "docs/sdd/plan.md", "docs/sdd/tasks.md", ".github/workflows/sdd.yml"],
};

interface ManifestStage {
  date: string;
  /** Tool version whose templates this stage installed (M4; absent on pre-M4 manifests). */
  templateVersion?: string;
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
    if (s.templateVersion !== undefined) lines.push(`    templateVersion: "${s.templateVersion}"`);
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
    const topVersion = typeof parsed["version"] === "string" ? parsed["version"] : TOOL_VERSION;
    for (const [k, v] of Object.entries(stagesRaw)) {
      const s = v as { date?: unknown; warnOnly?: unknown; files?: unknown; templateVersion?: unknown };
      if (typeof s !== "object" || s === null || typeof s.date !== "string" || !Array.isArray(s.files) || s.files.some((f) => typeof f !== "string")) {
        throw new Error(`stage "${k}" entry malformed`);
      }
      const tv = s.templateVersion;
      stages[k] = {
        date: s.date,
        files: s.files as string[],
        warnOnly: s.warnOnly === true ? true : undefined,
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
  writeFileSync(join(root, MANIFEST_FILE), stringifyManifest({ schemaVersion: SCHEMA_VERSION, tool: TOOL_NAME, version: TOOL_VERSION, stages }), "utf8");
}

// --- stage 2: gates installer ---------------------------------------------------

/** Cross-stack gates (installed for every stack; decision #13). The pre-commit
 *  config is NOT here — it is generated from detected tooling (M10, spec 0010). */
export const STAGE2_COMMON: Record<string, string> = {
  ".commitlintrc.json": "commitlintrc.json",
  ".markdownlint-cli2.yaml": "markdownlint-cli2.yaml",
};

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

/**
 * Whether the GitHub workflow template applies (spec 0008): no CI detected
 * (greenfield — GitHub assumption holds) or GitHub present (github wins over
 * a stray non-GitHub file). A non-GitHub platform means the workflow would be
 * a dead file — cross-stack gates only.
 */
export function workflowEligible(root: string): boolean {
  const platforms = ciPlatforms(root);
  return platforms.length === 0 || platforms.includes("github");
}

/** Stage-2 template map for a repo: cross-stack gates + its stack's workflow.
 *  The pre-commit config is generated (M10) unless the repo keeps another hook
 *  ecosystem (husky / lefthook — skip + notice, the spec 0008 treatment). */
export function stage2Templates(root: string): Record<string, string> {
  const stack = primaryStack(root);
  const tpl = { ...STAGE2_COMMON };
  if (stack && workflowEligible(root)) tpl[".github/workflows/ai-native.yml"] = STAGE2_WORKFLOWS[stack];
  const ecosystem = hookToolEcosystem(root);
  if (ecosystem !== "husky" && ecosystem !== "lefthook") tpl[PRE_COMMIT_FILE] = GENERATED;
  return tpl;
}

// --- M10: stack-aware pre-commit generation + hook-tool routing ------------------

export const PRE_COMMIT_FILE = ".pre-commit-config.yaml";

/** Marker for generated content in stage2Templates (M10). */
const GENERATED = "@generated";

export type HookTool = "pre-commit" | "husky" | "lefthook" | "none";

/** Existing git-hook ecosystem (M10): husky/lefthook repos keep their own hooks. */
export function hookToolEcosystem(root: string): HookTool {
  if (existsSync(join(root, "lefthook.yml"))) return "lefthook";
  if (existsSync(join(root, PRE_COMMIT_FILE))) return "pre-commit";
  const pkg = packageJsonOf(root);
  const all = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, unknown>;
  if (existsSync(join(root, ".husky")) || all["husky"] !== undefined) return "husky";
  return "none";
}

/** Files at the repo root (M10 detection — the same root boundary as detect). */
function hasAny(root: string, names: string[]): boolean {
  return names.some((n) => existsSync(join(root, n)));
}

function pythonPresent(root: string): boolean {
  return hasAny(root, ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".pylintrc", "ruff.toml", ".ruff.toml"]);
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
  if (hasAny(root, ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yml"])) return true;
  const pkg = packageJsonOf(root);
  return pkg !== null && pkg["eslintConfig"] !== undefined;
}

function tsconfigPresent(root: string): boolean {
  return hasAny(root, ["tsconfig.json"]);
}

function declaredScript(root: string, key: string): boolean {
  const pkg = packageJsonOf(root);
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {};
  return typeof scripts[key] === "string";
}

/** Declared npm script wrapper (the existing template pattern): runs the script
 *  when declared, skips with a notice otherwise — never masks a real failure. */
function declaredWrapper(key: string): string {
  return `bash -c 'node -e "const{execSync}=require(\\"node:child_process\\");const s=require(\\"./package.json\\").scripts||{};if(typeof s.${key}===\\"string\\"){console.log(\\"> npm run ${key}\\");execSync(\\"npm run ${key}\\",{stdio:\\"inherit\\"})}else console.log(\\"no ${key} script declared — skipped\\")"'`;
}

/** Cross-stack core (always): hygiene + markdownlint + commitlint + gitleaks. */
const PRE_COMMIT_CORE = `  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v6.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-json
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
 *  repos get the same local gate spooner dogfoods. Zero deps: no spooner
 *  scripts required in the target repo; python3 is guaranteed wherever
 *  pre-commit runs (pre-commit itself is a python tool — node is not).
 *  The parity test keeps this copy and the five workflow templates'
 *  copies from drifting. */
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
    lines.push(`  - repo: local
    hooks:
      - id: pytest
        name: pytest (python)
        entry: python3 -m pytest -q
        language: system
        pass_filenames: false
        files: \\.py$
        stages: [pre-commit]`);
  }
  if (pipAuditPresent(root)) {
    lines.push(`  - repo: local
    hooks:
      - id: pip-audit
        name: pip-audit (python deps)
        entry: pip-audit -r requirements.txt
        language: system
        pass_filenames: false
        files: ^requirements\\.txt$
        stages: [pre-commit]`);
  }
  return lines.join("\n");
}

/** Node gates (only when tooling detected; eslint managed + rev-pinned,
 *  typecheck/test local — SKIP'd in the node workflow template). */
function nodeHooks(root: string): string | null {
  const typecheckable = tsconfigPresent(root) || declaredScript(root, "typecheck");
  if (!eslintPresent(root) && !typecheckable && !declaredScript(root, "test")) return null;
  const lines: string[] = [];
  if (eslintPresent(root)) {
    lines.push(`  - repo: https://github.com/pre-commit/mirrors-eslint
    rev: v10.0.3
    hooks:
      - id: eslint
        args: [--max-warnings, "0"]
        files: \\.[jt]sx?$
        additional_dependencies:
          - eslint@10.0.3`);
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
  if (local.length > 0) lines.push(`  - repo: local
    hooks:
${local.join("\n")}`);
  return lines.join("\n");
}

/** Go gates (local system hooks — go toolchain is the repo's own; SKIP'd in the go workflow template). */
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
        entry: go test ./...
        language: system
        pass_filenames: false
        files: \\.go$
        stages: [pre-commit]`;
}

/** Java gates (local system hook — SKIP'd in the java workflow template). */
function javaHooks(root: string): string | null {
  if (!hasAny(root, ["pom.xml", "build.gradle"])) return null;
  const gradle = existsSync(join(root, "build.gradle"));
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
        files: (\\.java$|pom\\.xml$|build\\.gradle$)
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
export function generatePreCommitConfig(root: string): string {
  const sections = [
    `${GENERATED_PRE_COMMIT_MARKER} (M10: stack-aware)`,
    "# Install hooks (commitlint runs on the commit-msg stage — both are required):",
    "#   pre-commit install --hook-type pre-commit --hook-type commit-msg",
    "# Full run: pre-commit run --all-files",
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
    pythonHooks(root),
    nodeHooks(root),
    goHooks(root),
    rustHooks(root),
    javaHooks(root),
  ].filter((s): s is string => s !== null);
  return `${sections.join("\n")}\n`;
}

/** Resolve stage-2 file content: generated (M10) or template bytes. */
function stage2Content(root: string, file: string, tpl: string): string {
  return tpl === GENERATED ? generatePreCommitConfig(root) : templateContent(tpl);
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
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {};
  const build = ["build", "compile", "typecheck", "check", "verify"].find((k) => typeof scripts[k] === "string") ?? null;
  const test = ["test", "spec"].find((k) => typeof scripts[k] === "string") ?? null;
  return { build: build ? `npm run ${build}` : null, test: test ? `npm run ${test}` : null };
}

/**
 * Per-stack lifecycle commands (decision #13): node stays package.json-declared;
 * python/go/java use fixed standard commands, verified by the CI hard gate —
 * the same trust model as package.json scripts (the gate actually runs them).
 */
function stackLifecycle(root: string): { build: string | null; test: string | null } {
  const stack = primaryStack(root);
  if (stack === "go") return { build: "go build ./...", test: "go test ./..." };
  if (stack === "rust") return { build: "cargo build", test: "cargo test" };
  if (stack === "python") return { build: null, test: "python3 -m unittest discover -q || [ $? -eq 5 ]" };
  if (stack === "java") {
    if (existsSync(join(root, "build.gradle"))) {
      return { build: existsSync(join(root, "gradlew")) ? "./gradlew build" : "gradle build", test: null };
    }
    return { build: null, test: existsSync(join(root, "mvnw")) ? "./mvnw -q -B test" : "mvn -q -B test" };
  }
  return declaredNpmLifecycle(root);
}

function runCommand(root: string, command: string): boolean {
  try {
    execFileSync("sh", ["-c", command], { cwd: root, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function runDeclared(root: string): { ok: boolean; keys: string[] } {
  const { build, test } = stackLifecycle(root);
  const keys = [build, test].filter((k): k is string => k !== null);
  for (const k of keys) {
    if (!runCommand(root, k)) return { ok: false, keys };
  }
  return { ok: true, keys };
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
  if (ecosystem === "husky" || ecosystem === "lefthook") return "";
  if (templates[PRE_COMMIT_FILE] === undefined) return "";
  const installed =
    existsSync(join(root, ".git", "hooks", "pre-commit")) ||
    existsSync(join(root, ".git", "hooks", "commit-msg"));
  return installed ? "" : "; hooks not installed — run: pre-commit install --hook-type pre-commit --hook-type commit-msg";
}

export function applyStage2(root: string, dryRun: boolean): Stage2Result {
  const templates = stage2Templates(root);
  const plans: Stage2FilePlan[] = Object.entries(templates).map(([file, tpl]) => {
    const target = join(root, file);
    if (!existsSync(target)) return { file, action: "write" };
    const current = readFileSync(target, "utf8");
    if (current === stage2Content(root, file, tpl)) return { file, action: "keep" };
    // M10 legacy upgrade: bytes from the pre-M10 universal template, or any
    // generated config carrying the marker header (M12), are tool-owned.
    if (file === PRE_COMMIT_FILE && (current === templateContent(LEGACY_PRE_COMMIT_TEMPLATE) || current.includes(GENERATED_PRE_COMMIT_MARKER))) return { file, action: "write" };
    return { file, action: "conflict" };
  });
  const toWrite = plans.filter((p) => p.action === "write");
  const conflicts = plans.filter((p) => p.action === "conflict");
  const { build, test } = stackLifecycle(root);
  const command = [build, test].filter(Boolean).join(" && ") || null;

  // Unsupported-stack notice (decision #13): cross-stack gates only, no workflow.
  const stack = primaryStack(root);
  const detected = detect(root).stacks;
  const notice =
    stack !== null
      ? null
      : detected.length > 0
        ? `stack ${detected.join("/")}: transform not supported yet — audit works; supported stacks: node/python/go/java/rust (cross-stack gates installed, CI workflow skipped)`
        : "no recognized stack — cross-stack gates installed, CI workflow skipped (supported stacks: node/python/go/java/rust)";

  // Non-GitHub CI skip notice (spec 0008): the workflow would be a dead file on
  // GitLab/Jenkins/etc. — cross-stack gates install, the workflow is skipped.
  const platforms = ciPlatforms(root);
  const platformNotice =
    stack !== null && platforms.length > 0 && !platforms.includes("github")
      ? `CI workflow skipped: detected ${platforms.join("/")} (non-GitHub) — cross-stack gates installed`
      : null;

  // Hook-tool skip notice (M10, spec 0010): husky/lefthook ecosystems keep their
  // own hooks — the generated pre-commit config would be a foreign gate file.
  const ecosystem = hookToolEcosystem(root);
  const hookNotice =
    ecosystem === "husky" || ecosystem === "lefthook"
      ? `pre-commit config skipped: detected ${ecosystem} hook ecosystem — keep your existing git hooks (delete ${ecosystem === "husky" ? ".husky" : "lefthook.yml"} and re-run to install the generated pre-commit gates)`
      : null;

  // Wrong-stack workflow hint: installed bytes match a different stack's template.
  const workflowFile = ".github/workflows/ai-native.yml";
  let wrongStackHint: string | null = null;
  if (stack && templates[workflowFile]) {
    const target = join(root, workflowFile);
    if (existsSync(target)) {
      const installed = readFileSync(target, "utf8");
      if (installed !== templateContent(templates[workflowFile])) {
        const other = Object.entries(STAGE2_WORKFLOWS).find(([s, t]) => s !== stack && installed === templateContent(t));
        if (other) wrongStackHint = `installed workflow targets the ${other[0]} stack — delete ${workflowFile} and re-run to install the ${stack} workflow`;
      }
    }
  }
  const extra = [notice, platformNotice, wrongStackHint, hookNotice].filter(Boolean).join("; ");

  if (dryRun) {
    return {
      stage: 2,
      applied: false,
      dryRun: true,
      files: plans,
      buildCheck: { command, before: null, after: null },
      manifestUpdated: false,
      message: `dry-run: ${toWrite.length} file(s) to write, ${conflicts.length} conflict(s), ${plans.length - toWrite.length - conflicts.length} already installed; verification command: ${command ?? "none declared"}${extra ? `; ${extra}` : ""}${hookPromptOf(root, ecosystem, templates)}`,
    };
  }

  // Local verification runs the full declared family (incl. check/verify —
  // local tooling like pre-commit exists here); the CI gate template runs
  // self-contained families only (a clean CI checkout lacks that tooling).
  // A failure here names rollback or pre-existing, never fakes green.
  const before = command ? runDeclared(root).ok : null;
  for (const p of toWrite) {
    mkdirSync(join(root, p.file, ".."), { recursive: true });
    writeFileSync(join(root, p.file), stage2Content(root, p.file, templates[p.file]), "utf8");
  }
  const after = command ? runDeclared(root).ok : null;
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
        templateVersion: TOOL_VERSION,
        files: Object.keys(templates),
      }),
    );
  }

  let message: string;
  if (toWrite.length === 0 && conflicts.length === 0) {
    message = (manifestMissing ? "stage 2 files already installed; manifest restored" : "stage 2 already installed (no changes)") + (extra ? `; ${extra}` : "");
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
    else if (before === false) parts.push(`build was failing before apply (pre-existing); green after (${command})`);
    else parts.push(`build green before+after (${command})`);
    message = `stage 2 applied: ${parts.join("; ")}${extra ? `; ${extra}` : ""}${hookPromptOf(root, ecosystem, templates)}${manifestUpdated ? "; manifest updated" : ""}`;
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
 * Stack lifecycle commands (decision #13): standard commands traced to build
 * files, verified by the CI hard gate — same trust model as package.json scripts.
 */
function stackCommandsOf(root: string): { command: string; purpose: string }[] {
  const stacks = detect(root).stacks;
  const out: { command: string; purpose: string }[] = [];
  if (stacks.includes("go")) {
    out.push({ command: "go build ./...", purpose: "build" }, { command: "go test ./...", purpose: "test" }, { command: "go vet ./...", purpose: "vet" });
  }
  if (stacks.includes("rust")) {
    out.push(
      { command: "cargo build", purpose: "build" },
      { command: "cargo test", purpose: "test" },
      { command: "cargo fmt --check", purpose: "format check" },
      { command: "cargo clippy", purpose: "lint" },
    );
  }
  if (stacks.includes("python")) out.push({ command: "python3 -m unittest discover", purpose: "test" });
  if (stacks.includes("java")) {
    if (existsSync(join(root, "build.gradle"))) out.push({ command: "gradle build", purpose: "build + test" });
    else out.push({ command: existsSync(join(root, "mvnw")) ? "./mvnw -q -B test" : "mvn -q -B test", purpose: "test" });
  }
  return out;
}

/**
 * Deterministic AGENTS.md generation: every command traces to a real file
 * (package.json scripts / Makefile). Nothing is invented — the killer gate.
 */
export function generateAgentsMd(root: string): string {
  const pkg = packageJsonOf(root);
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, string>) : {};
  const stacks = detect(root).stacks;
  const name = typeof pkg?.name === "string" && pkg.name ? pkg.name : basename(resolve(root));
  const description = typeof pkg?.description === "string" ? pkg.description : null;
  const scriptKeys = Object.keys(scripts).sort();
  const makeTargets = makefileTargetsOf(root);
  const stackCmds = stackCommandsOf(root);
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
  if (scriptKeys.length === 0 && makeTargets.length === 0 && stackCmds.length === 0) {
    lines.push("- None declared. Add build/test commands (e.g. package.json scripts) to unlock the gates.", "");
  } else {
    lines.push("| Command | Purpose |", "|---|---|");
    for (const k of scriptKeys) lines.push(`| \`npm run ${k}\` | ${k} |`);
    for (const t of makeTargets) lines.push(`| \`make ${t}\` | Makefile target |`);
    for (const c of stackCmds) lines.push(`| \`${c.command}\` | ${c.purpose} |`);
    lines.push("");
  }
  lines.push("## Conventions", "");
  lines.push("- Follow the repo's existing conventions; keep the build green.", "");
  return lines.join("\n");
}

export function applyStage3(root: string, dryRun: boolean): Stage3Result {
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
      manifestWithStage(root, "3", { date: new Date().toISOString().slice(0, 10), templateVersion: TOOL_VERSION, files: ["AGENTS.md", "CLAUDE.md"] }),
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
    const note = agentsConflict
      ? `; existing AGENTS.md is user-written (${readFileSync(agentsPath, "utf8").split("\n").length} lines); the generated contract is ${generated.split("\n").length} lines of real commands — keep yours or merge`
      : "";
    message = `stage 3 applied: ${manifestUpdated ? "files written; " : ""}conflict(s) kept (not overwritten: ${conflicts.map((c) => c.file).join(", ")})${note}`;
  } else {
    const agents = agentsAction.action === "write" ? `written (${generated.split("\n").length} lines)` : "kept";
    const claude = claudeAction.action === "link" ? (process.platform === "win32" ? "@AGENTS.md import written" : "symlinked to AGENTS.md") : "kept";
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
    writeManifest(root, manifestWithStage(root, "4", { date: new Date().toISOString().slice(0, 10), templateVersion: TOOL_VERSION, files }));
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

/** Local commit gate (dogfood — mirrors the CI drift-gate job's baked EXPECTED
 *  compare): manifest present + files exist + version not stale vs the current
 *  tool. Catches the "stale ledger" failure class locally (the M10 push: local
 *  pre-commit read the working-tree manifest, CI read the committed one). */
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

function stageStatus(root: string, stage: number): StageReport {
  const files = stage === 2 ? Object.keys(stage2Templates(root)) : STAGE_FILES[stage];
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
    // local commit gate (dogfood): manifest present + consistent + not stale —
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
}
