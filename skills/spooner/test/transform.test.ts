import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ciPlatforms, primaryStack, stage2Templates, workflowEligible } from "../scripts/transform.ts";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "spooner-transform-"));
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
