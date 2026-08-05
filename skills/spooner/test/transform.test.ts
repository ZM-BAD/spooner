import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TEMPLATE_DIR,
  TOOL_VERSION,
  applyStage2,
  checkManifestGate,
  ciPlatforms,
  generatePreCommitConfig,
  hookToolEcosystem,
  primaryStack,
  stage2Templates,
  workflowEligible,
} from "../scripts/transform.ts";

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
  writeFileSync(join(repo, "Cargo.toml"), "[package]\n");
  const tpl = stage2Templates(repo);
  assert.ok(tpl[".commitlintrc.json"]);
  assert.equal(tpl[".github/workflows/ai-native.yml"], undefined);
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

test("preCommit: unsupported stack -> cross-stack core only, no local hooks", () => {
  const repo = fixture();
  writeFileSync(join(repo, "Cargo.toml"), "[package]\n");
  const cfg = generatePreCommitConfig(repo);
  assert.match(cfg, /id: gitleaks/);
  assert.doesNotMatch(cfg, /repo: local/);
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

test("preCommit: deterministic — two runs produce identical config", () => {
  const repo = fixture();
  writeFileSync(join(repo, "package.json"), '{"scripts":{"test":"echo t"}}\n');
  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  assert.equal(generatePreCommitConfig(repo), generatePreCommitConfig(repo));
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
