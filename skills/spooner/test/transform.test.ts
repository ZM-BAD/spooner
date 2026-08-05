import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TEMPLATE_DIR,
  TOOL_VERSION,
  applyStage2,
  applyStage3,
  checkManifestGate,
  ciPlatforms,
  generateAgentsMd,
  generatePreCommitConfig,
  hookToolEcosystem,
  manifestGateScript,
  primaryStack,
  stage2Templates,
  workflowEligible,
} from "../scripts/transform.ts";
import { runAudit } from "../scripts/audit.ts";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "spooner-transform-"));
}

function readTemplate(name: string): string {
  return readFileSync(join(TEMPLATE_DIR, name), "utf8");
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

test("stage2Templates: no CI -> workflow included (greenfield GitHub assumption)", () => {
  const repo = nodeRepo(fixture());
  const tpl = stage2Templates(repo);
  assert.ok(tpl[".github/workflows/ai-native.yml"]);
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
  writeFileSync(join(repo, "Cargo.toml"), "[package]\nname = \"x\"\nversion = \"0.1.0\"\n");
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
  writeFileSync(join(repo, "Cargo.toml"), "[package]\nname = \"x\"\nversion = \"0.1.0\"\n");
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /id: cargo-fmt/);
  assert.match(cfg, /id: cargo-clippy/);
  assert.match(cfg, /id: cargo-test/);
  assert.doesNotMatch(cfg, /-D warnings/);
  rmSync(repo, { recursive: true, force: true });
});

test("stage3: rust fixture -> AGENTS.md lists cargo commands", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Cargo.toml"), "[package]\nname = \"x\"\nversion = \"0.1.0\"\n");
  const md = generateAgentsMd(repo);
  assert.match(md, /cargo build/);
  assert.match(md, /cargo test/);
  assert.match(md, /cargo fmt --check/);
  assert.match(md, /cargo clippy/);
  rmSync(repo, { recursive: true, force: true });
});

test("audit: rust fixture credits agents-commands 0.6/1 from Cargo.toml", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Cargo.toml"), "[package]\nname = \"x\"\nversion = \"0.1.0\"\n");
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
  writeFileSync(join(repo, ".pre-commit-config.yaml"), "# pre-commit config generated by spooner transform Stage 2 (M10: stack-aware)\nrepos:\n  - repo: local\n    hooks:\n      - id: old-hook\n");
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
  const installed = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "ai-native.yml"), "utf8");
  assert.equal(installed, readTemplate("ci-workflow-node.yml"));
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
  writeFileSync(join(repo, ".ai-native.yml"), 'schemaVersion: 2\ntool: spooner\nversion: "0.5.0"\nstages:\n  2:\n    files: []\n');
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
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "test -f .pre-commit-config.yaml" } }));
  const r = applyStage2(repo, false);
  assert.equal(r.buildCheck.before, false);
  assert.equal(r.buildCheck.after, true);
  assert.match(r.message ?? "", /failing before apply \(pre-existing\)/);
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

test("stage 2: report prompts hook install when .git/hooks is empty", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".git"), { recursive: true });
  const r = applyStage2(repo, false);
  assert.match(r.message ?? "", /hooks not installed — run: pre-commit install --hook-type pre-commit --hook-type commit-msg/);
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
