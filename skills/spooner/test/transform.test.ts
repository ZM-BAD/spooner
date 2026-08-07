import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TEMPLATE_DIR,
  TOOL_VERSION,
  applyStage2,
  applyStage3,
  applyStage4,
  stage4Templates,
  checkManifestGate,
  ciPlatforms,
  generateAgentsMd,
  generatePreCommitConfig,
  hookToolEcosystem,
  manifestGateScript,
  primaryStack,
  stage2Templates,
  workflowEligible,
  workflowSkipReason,
} from "../scripts/transform.ts";
import { runAudit } from "../scripts/audit.ts";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "spooner-transform-"));
}

function readTemplate(name: string): string {
  return readFileSync(join(TEMPLATE_DIR, name), "utf8");
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function nodeRepo(dir: string): string {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"x","scripts":{"build":"echo b","test":"echo t"}}\n');
  return repo;
}

test("primaryStack: node wins over python in a mixed repo", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), "{}\n");
  writeFileSync(join(repo, "pyproject.toml"), "[project]\n");
  assert.equal(primaryStack(repo), "node");
  rmSync(repo, { recursive: true, force: true });
});

test("primaryStack: python when only python manifests", () => {
  const repo = fixture();
  writeFileSync(join(repo, "pyproject.toml"), "[project]\n");
  assert.equal(primaryStack(repo), "python");
  rmSync(repo, { recursive: true, force: true });
});

test("ciPlatforms: gitlab fixture detected", () => {
  const repo = nodeRepo(fixture());
  writeFileSync(join(repo, ".gitlab-ci.yml"), "stages: [build]\n");
  assert.deepEqual(ciPlatforms(repo), ["gitlab"]);
  assert.equal(workflowEligible(repo), false);
  rmSync(repo, { recursive: true, force: true });
});

test("ciPlatforms: github presence wins over a stray non-GitHub file", () => {
  const repo = nodeRepo(fixture());
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: ci\n");
  writeFileSync(join(repo, "Jenkinsfile"), "pipeline {}\n");
  assert.deepEqual(ciPlatforms(repo), ["github", "jenkins"]);
  assert.equal(workflowEligible(repo), true);
  rmSync(repo, { recursive: true, force: true });
});

test("stage2Templates: no CI + no remote -> workflow included (greenfield GitHub assumption)", () => {
  const repo = nodeRepo(fixture());
  const tpl = stage2Templates(repo);
  assert.ok(tpl[".github/workflows/ai-native.yml"]);
  rmSync(repo, { recursive: true, force: true });
});

test("stage2Templates: greenfield + gitlab origin remote -> no workflow (no dead CI file)", () => {
  const repo = nodeRepo(fixture());
  git(repo, ["init", "-q"]);
  git(repo, ["remote", "add", "origin", "git@gitlab.com:group/repo.git"]);
  const tpl = stage2Templates(repo);
  assert.equal(tpl[".github/workflows/ai-native.yml"], undefined);
  assert.match(workflowSkipReason(repo) ?? "", /origin remote host gitlab \(non-GitHub\)/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage2Templates: greenfield + github origin remote -> workflow included", () => {
  const repo = nodeRepo(fixture());
  git(repo, ["init", "-q"]);
  git(repo, ["remote", "add", "origin", "https://github.com/ZM-BAD/spooner.git"]);
  const tpl = stage2Templates(repo);
  assert.ok(tpl[".github/workflows/ai-native.yml"]);
  rmSync(repo, { recursive: true, force: true });
});

test("stage2Templates: --ci none overrides a github-detected repo (no workflow)", () => {
  const repo = nodeRepo(fixture());
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  assert.ok(stage2Templates(repo)[".github/workflows/ai-native.yml"], "auto-detection should include the workflow");
  const tpl = stage2Templates(repo, "none");
  assert.equal(tpl[".github/workflows/ai-native.yml"], undefined);
  assert.match(workflowSkipReason(repo, "none") ?? "", /none \(explicit\)/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage2Templates: --ci github overrides a gitlab remote (workflow included)", () => {
  const repo = nodeRepo(fixture());
  git(repo, ["init", "-q"]);
  git(repo, ["remote", "add", "origin", "git@gitlab.com:group/repo.git"]);
  const tpl = stage2Templates(repo, "github");
  assert.ok(tpl[".github/workflows/ai-native.yml"]);
  rmSync(repo, { recursive: true, force: true });
});

test("stage 2: gitlab-remote greenfield installs gates only + reports the skip notice", () => {
  const repo = nodeRepo(fixture());
  git(repo, ["init", "-q"]);
  git(repo, ["remote", "add", "origin", "git@gitlab.com:group/repo.git"]);
  const r = applyStage2(repo, false);
  assert.ok(!existsSync(join(repo, ".github/workflows/ai-native.yml")));
  assert.match(r.message ?? "", /CI workflow skipped: origin remote host gitlab/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage2Templates: gitlab -> cross-stack gates only, no workflow (M8 routing)", () => {
  const repo = nodeRepo(fixture());
  writeFileSync(join(repo, ".gitlab-ci.yml"), "stages: [build]\n");
  const tpl = stage2Templates(repo);
  assert.ok(tpl[".commitlintrc.json"]);
  assert.ok(tpl[".pre-commit-config.yaml"]);
  assert.ok(tpl[".markdownlint-cli2.yaml"]);
  assert.equal(tpl[".github/workflows/ai-native.yml"], undefined);
  rmSync(repo, { recursive: true, force: true });
});

test("stage2Templates: unsupported stack -> cross-stack gates only, no workflow", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Gemfile"), 'source "https://rubygems.org"\n');
  const tpl = stage2Templates(repo);
  assert.ok(tpl[".commitlintrc.json"]);
  assert.equal(tpl[".github/workflows/ai-native.yml"], undefined);
  rmSync(repo, { recursive: true, force: true });
});

test("stage2Templates: rust picks the rust workflow template", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
  assert.equal(primaryStack(repo), "rust");
  const tpl = stage2Templates(repo);
  assert.equal(tpl[".github/workflows/ai-native.yml"], "ci-workflow-rust.yml");
  rmSync(repo, { recursive: true, force: true });
});

test("stage2Templates: java picks the java workflow template", () => {
  const repo = fixture();
  writeFileSync(join(repo, "pom.xml"), "<project/>\n");
  const tpl = stage2Templates(repo);
  assert.equal(tpl[".github/workflows/ai-native.yml"], "ci-workflow-java.yml");
  rmSync(repo, { recursive: true, force: true });
});

// --- M10: stack-aware pre-commit generation + hook-tool routing ------------------

test("preCommit: python fixture -> ruff/pytest/pip-audit, no eslint/tsc", () => {
  const repo = fixture();
  writeFileSync(join(repo, "pyproject.toml"), "[project]\n[tool.pytest.ini_options]\n");
  writeFileSync(join(repo, "requirements.txt"), "requests\n");
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /id: ruff/);
  assert.match(cfg, /id: ruff-format/);
  assert.match(cfg, /id: pytest/);
  assert.match(cfg, /id: pip-audit/);
  assert.doesNotMatch(cfg, /id: eslint/);
  assert.doesNotMatch(cfg, /id: typecheck/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: node fixture -> eslint/typecheck/test, no ruff", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), '{"scripts":{"test":"echo t"}}\n');
  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  writeFileSync(join(repo, "eslint.config.js"), "export default []\n");
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /id: eslint/);
  assert.match(cfg, /id: typecheck/);
  assert.match(cfg, /id: test/);
  assert.doesNotMatch(cfg, /id: ruff/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: eslint hook carries types: [] — mirrors-eslint's javascript default filters .ts out (dogfood 2026-08-07)", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  writeFileSync(join(repo, "eslint.config.mjs"), "export default [];\n");
  const cfg = generatePreCommitConfig(repo);
  const eslintBlock = cfg.slice(cfg.indexOf("mirrors-eslint"));
  assert.match(eslintBlock, /types: \[\]/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: tool-absent node repo -> cross-stack core only, no dead hooks", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), "{}\n");
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /id: gitleaks/);
  assert.doesNotMatch(cfg, /id: eslint/);
  assert.doesNotMatch(cfg, /id: typecheck/);
  assert.doesNotMatch(cfg, /id: test/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: go fixture -> gofmt/vet/test", () => {
  const repo = fixture();
  writeFileSync(join(repo, "go.mod"), "module x\n");
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /id: gofmt/);
  assert.match(cfg, /id: go-vet/);
  assert.match(cfg, /id: go-test/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: java fixture -> mvn test local hook", () => {
  const repo = fixture();
  writeFileSync(join(repo, "pom.xml"), "<project/>\n");
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /id: java-test/);
  assert.match(cfg, /mvn -q -B test/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: unsupported stack -> cross-stack core + manifest gate only, no stack hooks", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Gemfile"), 'source "https://rubygems.org"\n');
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /id: gitleaks/);
  assert.match(cfg, /id: manifest-consistency/);
  assert.equal((cfg.match(/repo: local/g) ?? []).length, 1); // the M12 manifest gate only
  assert.doesNotMatch(cfg, /cargo-|gofmt|mvn-test|pytest/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage2: unsupported stack notice names the full supported list incl. rust", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Gemfile"), 'source "https://rubygems.org"\n');
  const r = applyStage2(repo, true);
  assert.match(r.message ?? "", /not supported yet/);
  assert.match(r.message ?? "", /node\/python\/go\/java\/rust/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: rust fixture -> cargo fmt/clippy/test, no -D warnings", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /id: cargo-fmt/);
  assert.match(cfg, /id: cargo-clippy/);
  assert.match(cfg, /id: cargo-test/);
  assert.doesNotMatch(cfg, /-D warnings/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage3: rust fixture -> AGENTS.md lists cargo commands", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
  const md = generateAgentsMd(repo);
  assert.match(md, /cargo build/);
  assert.match(md, /cargo test/);
  assert.match(md, /cargo fmt --check/);
  assert.match(md, /cargo clippy/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage3: AGENTS.md conventions are stack-aware (rust)", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
  const md = generateAgentsMd(repo);
  assert.match(md, /Rust: run `cargo fmt` and `cargo clippy` before committing/);
  assert.doesNotMatch(md, /virtualenv/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage3: python fixture conventions mention virtualenv (stack-aware copy)", () => {
  const repo = fixture();
  writeFileSync(join(repo, "requirements.txt"), "requests==2.31.0\n");
  const md = generateAgentsMd(repo);
  assert.match(md, /Python: install dependencies via pip inside a virtualenv/);
  assert.doesNotMatch(md, /cargo fmt/);
  rmSync(repo, { recursive: true, force: true });
});

test("audit: rust fixture credits agents-commands 0.6/1 from Cargo.toml", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
  const r = runAudit(repo);
  const cmd = r.items.find((i) => i.id === "agents-commands");
  assert.equal(cmd?.score, 0.6);
  assert.match(cmd?.evidence ?? "", /Cargo.toml \(cargo build\/test\)/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: husky ecosystem -> config skipped + explicit notice", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), '{"devDependencies":{"husky":"9"}}\n');
  mkdirSync(join(repo, ".husky"));
  assert.equal(hookToolEcosystem(repo), "husky");
  assert.equal(stage2Templates(repo)[".pre-commit-config.yaml"], undefined);
  const r = applyStage2(repo, true);
  assert.match(r.message ?? "", /pre-commit config skipped: detected husky/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: lefthook ecosystem -> config skipped", () => {
  const repo = fixture();
  writeFileSync(join(repo, "lefthook.yml"), "pre-commit:\n");
  assert.equal(hookToolEcosystem(repo), "lefthook");
  assert.equal(stage2Templates(repo)[".pre-commit-config.yaml"], undefined);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: legacy template bytes -> write (upgrade), user edit -> conflict", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), "{}\n");
  writeFileSync(join(repo, ".pre-commit-config.yaml"), readTemplate("pre-commit-config.yaml"));
  let r = applyStage2(repo, true);
  assert.equal(r.files.find((f) => f.file === ".pre-commit-config.yaml")?.action, "write");
  writeFileSync(join(repo, ".pre-commit-config.yaml"), "# user-owned config\n");
  r = applyStage2(repo, true);
  assert.equal(r.files.find((f) => f.file === ".pre-commit-config.yaml")?.action, "conflict");
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: M10-era generated config (marker header) -> write, user edit without marker -> conflict", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), "{}\n");
  // stale M10-era generation: marker header, no M12 manifest gate
  writeFileSync(
    join(repo, ".pre-commit-config.yaml"),
    "# pre-commit config generated by spooner transform Stage 2 (M10: stack-aware)\nrepos:\n  - repo: local\n    hooks:\n      - id: old-hook\n",
  );
  let r = applyStage2(repo, true);
  assert.equal(r.files.find((f) => f.file === ".pre-commit-config.yaml")?.action, "write");
  writeFileSync(join(repo, ".pre-commit-config.yaml"), "# user-owned config\n");
  r = applyStage2(repo, true);
  assert.equal(r.files.find((f) => f.file === ".pre-commit-config.yaml")?.action, "conflict");
  rmSync(repo, { recursive: true, force: true });
});

/** Extract the CI hard-gate job's python3 heredoc script from a workflow template. */
function templateGateScript(tpl: string): string {
  const job = tpl.slice(tpl.indexOf("Check manifest consistency and template staleness"));
  const m = job.match(/<<'PY'\n([\s\S]*?)\n *PY/);
  assert.ok(m, "template has the python3 heredoc gate script");
  const lines = m[1].split("\n");
  const min = Math.min(...lines.filter((l) => l.trim().length > 0).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => (l.trim().length === 0 ? "" : l.slice(min))).join("\n") + "\n";
}

test("parity: generator gate script equals the CI hard-gate script in all five templates", () => {
  for (const stack of ["node", "python", "go", "java", "rust"]) {
    assert.equal(templateGateScript(readTemplate(`ci-workflow-${stack}.yml`)), manifestGateScript(), stack);
  }
});

test("parity: installed dogfood workflow stays byte-equal to the node template", () => {
  const installed = readFileSync(
    join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "ai-native.yml"),
    "utf8",
  );
  assert.equal(installed, readTemplate("ci-workflow-node.yml"));
});

test("parity: installed dogfood pre-commit config bakes the current EXPECTED", () => {
  // Regression (2026-08-07): the 0.9.0 bump left the installed config's baked
  // EXPECTED at 0.8.0 for two bumps — the one-directional gate hid it locally
  // and parity pinned the installed workflow but not the installed config.
  // The entry is a YAML double-quoted string, so the inner quotes are escaped.
  const installed = readFileSync(join(import.meta.dirname, "..", "..", "..", ".pre-commit-config.yaml"), "utf8");
  assert.match(installed, new RegExp(`EXPECTED = \\\\"${TOOL_VERSION}\\\\"`));
});

/** Hook ids under `repo: local` blocks in a generated pre-commit config. */
function localHookIds(config: string): string[] {
  const ids: string[] = [];
  let inLocal = false;
  for (const line of config.split("\n")) {
    if (/^\s+- repo:/.test(line)) inLocal = line.includes("repo: local");
    else if (inLocal) {
      const m = line.match(/^\s+- id: ([a-z0-9-]+)/);
      if (m) ids.push(m[1]);
    }
  }
  return ids;
}

/** The SKIP list of a workflow template's pre-commit job. */
function templateSkip(tpl: string): string[] {
  const m = tpl.match(/SKIP:\s*([^\n]+)/);
  return m
    ? m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** Minimal per-stack fixture that triggers the stack's local hooks. */
function stackRepo(root: string, stack: "node" | "python" | "go" | "java" | "rust"): string {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const manifests: Record<string, [string, string]> = {
    node: ["package.json", '{"name":"x","scripts":{"test":"echo t"}}'],
    go: ["go.mod", "module x\n\ngo 1.21\n"],
    rust: ["Cargo.toml", '[package]\nname = "x"\nversion = "0.1.0"\n'],
    java: [
      "pom.xml",
      "<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>x</artifactId><version>1</version></project>",
    ],
  };
  const manifest = manifests[stack];
  if (manifest) writeFileSync(join(repo, manifest[0]), manifest[1]);
  if (stack === "node") writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  if (stack === "python") {
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "requirements.txt"), "");
  }
  return repo;
}

test("parity: every local hook id the generator emits is SKIP'd in the stack workflow template", () => {
  // Regression (review 2026-08-06): the java template SKIP'd `mvn-test` while
  // the generator emits `java-test` — CI's no-toolchain pre-commit job then
  // ran the java-test local hook for real (mvn missing → always red, masked
  // by continue-on-error). The SKIP list must cover every local hook.
  for (const stack of ["node", "python", "go", "java", "rust"] as const) {
    const root = fixture();
    const repo = stackRepo(root, stack);
    const config = generatePreCommitConfig(repo);
    const skip = templateSkip(readTemplate(`ci-workflow-${stack}.yml`));
    for (const id of localHookIds(config)) {
      assert.ok(
        skip.includes(id),
        `${stack}: local hook "${id}" must be SKIP'd in ci-workflow-${stack}.yml (CI pre-commit job has no repo toolchain)`,
      );
    }
    // Managed hooks that load repo-side configs need SKIP too (review
    // 2026-08-07): the eslint hook resolves typescript-eslint from the repo's
    // node_modules, which the CI pre-commit job does not install — lint runs
    // in the lint-test job instead.
    if (stack === "node") {
      assert.ok(
        skip.includes("eslint"),
        "node: managed eslint hook must be SKIP'd in ci-workflow-node.yml (config deps live in repo node_modules)",
      );
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("preCommit: deterministic — two runs produce identical config", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), '{"scripts":{"test":"echo t"}}\n');
  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  assert.equal(generatePreCommitConfig(repo), generatePreCommitConfig(repo));
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: generated config carries the self-contained manifest gate (M12)", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), "{}\n");
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /id: manifest-consistency/);
  assert.match(cfg, /pass_filenames: false/);
  assert.match(cfg, /always_run: true/);
  assert.match(cfg, /stages: \[pre-commit\]/);
  const m = cfg.match(/entry: "((?:[^"\\]|\\.)*)"/);
  assert.ok(m, "entry line with a double-quoted value");
  const value = JSON.parse('"' + m[1] + '"');
  assert.ok(value.startsWith("python3 -c '"), "entry runs python3 -c");
  assert.ok(value.includes(manifestGateScript()), "entry embeds the full gate script");
  rmSync(repo, { recursive: true, force: true });
});

test("manifestGateScript: bakes the current TOOL_VERSION as EXPECTED", () => {
  assert.match(manifestGateScript(), new RegExp(`EXPECTED = "${TOOL_VERSION}"`));
});

function runGate(dir: string): { status: number; stderr: string } {
  try {
    execFileSync("python3", ["-c", manifestGateScript()], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    return { status: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string };
    return { status: err.status ?? 1, stderr: String(err.stderr ?? "") };
  }
}

test("manifestGateScript: stale manifest version exits non-zero with run-sync wording", () => {
  const repo = fixture();
  gateManifest(repo, "0.0.1", []);
  const r = runGate(repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /run sync to apply the current templates/);
  rmSync(repo, { recursive: true, force: true });
});

test("manifestGateScript: missing declared file exits non-zero with a stage hint", () => {
  const repo = fixture();
  gateManifest(repo, TOOL_VERSION, ["ghost.txt"]);
  const r = runGate(repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /manifest drift — missing: ghost\.txt/);
  assert.match(r.stderr, /re-run transform stage 2/);
  rmSync(repo, { recursive: true, force: true });
});

test("manifestGateScript: absent manifest exits non-zero with stage-2 wording", () => {
  const repo = fixture();
  const r = runGate(repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /run transform stage 2 first/);
  rmSync(repo, { recursive: true, force: true });
});

test("manifestGateScript: consistent manifest exits 0", () => {
  const repo = fixture();
  gateManifest(repo, TOOL_VERSION, []);
  const r = runGate(repo);
  assert.equal(r.status, 0);
  rmSync(repo, { recursive: true, force: true });
});

test("manifestGateScript: unparseable manifest exits non-zero with parse-error wording", () => {
  const repo = fixture();
  writeFileSync(join(repo, ".ai-native.yml"), "no-colon-here\n");
  const r = runGate(repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /manifest parse error/);
  rmSync(repo, { recursive: true, force: true });
});

test("manifestGateScript: schema mismatch exits non-zero with schema wording", () => {
  const repo = fixture();
  writeFileSync(
    join(repo, ".ai-native.yml"),
    'schemaVersion: 2\ntool: spooner\nversion: "0.0.1"\nstages:\n  2:\n    files: []\n',
  );
  const r = runGate(repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /manifest schema mismatch/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: plain-JS node repo (test script, no tsconfig) -> test hook under repo: local, not orphaned", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), '{"scripts":{"test":"jest"}}\n');
  writeFileSync(join(repo, "eslint.config.js"), "export default []\n");
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /repo: local\n    hooks:\n      - id: test/);
  assert.doesNotMatch(cfg, /mirrors-eslint\n    hooks:\n      - id: eslint\n      - id: test/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: check-only — no --fix/--write/upgrade hooks", () => {
  const repo = fixture();
  writeFileSync(join(repo, "pyproject.toml"), "[project]\n[tool.pytest.ini_options]\n");
  writeFileSync(join(repo, "requirements.txt"), "requests\n");
  writeFileSync(join(repo, "package.json"), '{"scripts":{"test":"echo t"}}\n');
  const cfg = generatePreCommitConfig(repo);
  assert.doesNotMatch(cfg, /--fix/);
  assert.doesNotMatch(cfg, /--write/);
  assert.doesNotMatch(cfg, /upgrade/);
  rmSync(repo, { recursive: true, force: true });
});

// --- manifest gate (dogfood: local pre-commit mirrors the CI drift gate) ---------

function gateManifest(repo: string, version: string, files: string[]): void {
  writeFileSync(
    join(repo, ".ai-native.yml"),
    `schemaVersion: 1\ntool: spooner\nversion: "${version}"\nstages:\n  2:\n    date: "2026-08-05"\n    files:\n${files.map((f) => `      - "${f}"`).join("\n")}\n`,
  );
}

test("manifestGate: consistent manifest at current version passes", () => {
  const repo = fixture();
  gateManifest(repo, TOOL_VERSION, ["AGENTS.md"]);
  writeFileSync(join(repo, "AGENTS.md"), "# x\n");
  const g = checkManifestGate(repo);
  assert.equal(g.ok, true);
  assert.equal(g.stale, false);
  assert.deepEqual(g.missing, []);
  rmSync(repo, { recursive: true, force: true });
});

test("manifestGate: stale version fails — the M10 push failure class", () => {
  const repo = fixture();
  gateManifest(repo, "0.2.7", ["AGENTS.md"]);
  writeFileSync(join(repo, "AGENTS.md"), "# x\n");
  const g = checkManifestGate(repo);
  assert.equal(g.ok, false);
  assert.equal(g.stale, true);
  rmSync(repo, { recursive: true, force: true });
});

test("manifestGate: missing manifest-listed file fails", () => {
  const repo = fixture();
  gateManifest(repo, TOOL_VERSION, ["AGENTS.md", "CLAUDE.md"]);
  writeFileSync(join(repo, "AGENTS.md"), "# x\n");
  const g = checkManifestGate(repo);
  assert.equal(g.ok, false);
  assert.deepEqual(g.missing, ["CLAUDE.md"]);
  rmSync(repo, { recursive: true, force: true });
});

test("manifestGate: no manifest fails", () => {
  const repo = fixture();
  const g = checkManifestGate(repo);
  assert.equal(g.ok, false);
  assert.equal(g.version, null);
  rmSync(repo, { recursive: true, force: true });
});

// --- M13 slice 3: report truth -------------------------------------------------

test("stage 2: build-verification message is honest when before fails and after passes", () => {
  const repo = fixture();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "test -f .pre-commit-config.yaml" } }),
  );
  const r = applyStage2(repo, false);
  assert.equal(r.buildCheck.before, false);
  assert.equal(r.buildCheck.after, true);
  assert.match(r.message ?? "", /failing before apply \(pre-existing/);
  assert.match(r.buildCheck.error ?? "", /npm run test — exit 1/);
  assert.ok(!r.message?.includes("green before+after"), `message claims green: ${r.message}`);
  rmSync(repo, { recursive: true, force: true });
});

test("stage 2: 'green before+after' wording unchanged when both sides pass", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "true" } }));
  const r = applyStage2(repo, false);
  assert.equal(r.buildCheck.before, true);
  assert.equal(r.buildCheck.after, true);
  assert.match(r.message ?? "", /green before\+after/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage 2: pre-existing build failure reports the reason (exit code + stderr)", () => {
  const repo = fixture();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "x", scripts: { build: "echo boom >&2 && exit 3" } }),
  );
  const r = applyStage2(repo, false);
  assert.equal(r.buildCheck.before, false);
  assert.match(r.buildCheck.error ?? "", /npm run build — exit 3: boom/);
  assert.match(r.message ?? "", /pre-existing — npm run build — exit 3: boom/);
  assert.match(r.message ?? "", /installed hooks are hard gates \(commits stay blocked until the build is fixed\)/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage 2: report prompts hook install when .git/hooks is empty", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const r = applyStage2(repo, false);
  assert.match(
    r.message ?? "",
    /hooks not installed — run: pre-commit install --hook-type pre-commit --hook-type commit-msg/,
  );
  rmSync(repo, { recursive: true, force: true });
});

test("stage 2: no hook prompt when hooks are installed", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
  const r = applyStage2(repo, false);
  assert.ok(!r.message?.includes("pre-commit install"), `prompt present: ${r.message}`);
  rmSync(repo, { recursive: true, force: true });
});

test("stage 3: user-written AGENTS.md conflict names both line counts + merge option", () => {
  const repo = fixture();
  writeFileSync(join(repo, "AGENTS.md"), Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n"));
  const r = applyStage3(repo, false);
  const conflict = r.files.find((f) => f.file === "AGENTS.md");
  assert.equal(conflict?.action, "conflict");
  assert.match(r.message ?? "", /user-written \(120 lines\)/);
  assert.match(r.message ?? "", /generated contract is \d+ lines/);
  assert.match(r.message ?? "", /keep yours or merge/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage 3: no existing AGENTS.md -> plain write, no conflict note", () => {
  const repo = fixture();
  const r = applyStage3(repo, false);
  assert.equal(r.files.find((f) => f.file === "AGENTS.md")?.action, "write");
  assert.ok(!r.message?.includes("user-written"), `note present: ${r.message}`);
  rmSync(repo, { recursive: true, force: true });
});

test("stage 3: broken-symlink CLAUDE.md -> conflict, never crashes", () => {
  const repo = fixture();
  // a symlink pointing at a missing target — no AGENTS.md in the repo
  symlinkSync("does-not-exist.md", join(repo, "CLAUDE.md"));
  const r = applyStage3(repo, false);
  assert.equal(r.files.find((f) => f.file === "CLAUDE.md")?.action, "conflict");
  assert.ok(!r.message?.includes("ENOENT"), `uncaught error leaked: ${r.message}`);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: dead husky dependency (no .husky, no husky field) installs the gates — no ecosystem skip", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), '{"devDependencies":{"husky":"^4.3.8"}}\n');
  assert.equal(hookToolEcosystem(repo), "none", "a bare dependency name is a dead dependency");
  assert.ok(stage2Templates(repo)[".pre-commit-config.yaml"], "gate must be installed");
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: husky v4 field (dependency + package.json field) skips with a remove-the-field hint", () => {
  const repo = fixture();
  writeFileSync(
    join(repo, "package.json"),
    '{"devDependencies":{"husky":"^4.3.8"},"husky":{"hooks":{"pre-commit":"lint-staged"}}}\n',
  );
  assert.equal(hookToolEcosystem(repo), "husky");
  assert.equal(stage2Templates(repo)[".pre-commit-config.yaml"], undefined);
  const r = applyStage2(repo, true);
  assert.match(r.message ?? "", /remove the husky field from package\.json/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: yorkie ecosystem (vue-cli default) -> config skipped + explicit notice", () => {
  const repo = fixture();
  writeFileSync(
    join(repo, "package.json"),
    '{"devDependencies":{"yorkie":"^2.0.0","lint-staged":"^10.0.0"},"yorkie":{"hooks":{"pre-commit":"lint-staged"}}}\n',
  );
  assert.equal(hookToolEcosystem(repo), "yorkie");
  assert.equal(stage2Templates(repo)[".pre-commit-config.yaml"], undefined);
  const r = applyStage2(repo, true);
  assert.match(r.message ?? "", /pre-commit config skipped: detected yorkie/);
  assert.match(r.message ?? "", /remove the yorkie dependency/);
  rmSync(repo, { recursive: true, force: true });
});

// --- kotlin/Android (build.gradle.kts) recognition (2026-08-07) ---

test("primaryStack: build.gradle.kts + settings.gradle.kts register as java (kotlin/Android)", () => {
  const repo = fixture();
  mkdirSync(join(repo, "app"), { recursive: true });
  writeFileSync(join(repo, "settings.gradle.kts"), 'rootProject.name = "app"\ninclude(":app")\n');
  writeFileSync(join(repo, "app", "build.gradle.kts"), 'plugins { id("com.android.application") }\n');
  assert.equal(primaryStack(repo), "java", "kotlin gradle project must resolve to java");
  const t = stage2Templates(repo);
  assert.ok(t[".github/workflows/ai-native.yml"], "java workflow must be selected");
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /java-test/);
  assert.match(cfg, /build\\.gradle\\.kts/);
  rmSync(repo, { recursive: true, force: true });
});

test("javaHooks: .kt files trigger the java-test hook (kotlin code is the trigger set)", () => {
  const repo = fixture();
  writeFileSync(join(repo, "build.gradle.kts"), 'plugins { id("org.jetbrains.kotlin.android") }\n');
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /\\.kt\$/);
  rmSync(repo, { recursive: true, force: true });
});

test("preCommit: yorkie with legacy gitHooks field (vue-cli 2/3) skips the config — not a dead dep", () => {
  const repo = fixture();
  writeFileSync(
    join(repo, "package.json"),
    '{"devDependencies":{"yorkie":"^2.0.0"},"gitHooks":{"pre-commit":"lint-staged"}}\n',
  );
  assert.equal(hookToolEcosystem(repo), "yorkie", "yorkie reads the gitHooks field");
  assert.equal(stage2Templates(repo)[".pre-commit-config.yaml"], undefined);
  rmSync(repo, { recursive: true, force: true });
});

test("stage 4: gitlab remote greenfield skips the sdd workflow with a notice (stage2 parity, 2026-08-07)", () => {
  const repo = fixture();
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@gitlab.com:acme/app.git"], { cwd: repo, stdio: "ignore" });
  const t = stage4Templates(repo);
  assert.equal(t[".github/workflows/sdd.yml"], undefined, "no dead sdd workflow on gitlab");
  assert.ok(t["docs/sdd/spec.md"], "sdd docs still install");
  const r = applyStage4(repo, true);
  assert.match(r.message ?? "", /origin remote host gitlab \(non-GitHub\).*SDD spec gate/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage 4: --ci github overrides a gitlab remote (sdd workflow included)", () => {
  const repo = fixture();
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@gitlab.com:acme/app.git"], { cwd: repo, stdio: "ignore" });
  const t = stage4Templates(repo, "github");
  assert.ok(t[".github/workflows/sdd.yml"], "--ci github forces the workflow");
  rmSync(repo, { recursive: true, force: true });
});
