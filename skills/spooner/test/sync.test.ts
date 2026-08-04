import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../scripts/sync.ts";
import { TEMPLATE_DIR, TOOL_VERSION } from "../scripts/transform.ts";

function readTemplate(name: string): string {
  return readFileSync(join(TEMPLATE_DIR, name), "utf8");
}

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "spooner-sync-"));
}

/** Manifest with one stage-2 entry (template-backed file) + one stage-3 (generated). */
function writeManifest(repo: string, version: string, file: string): void {
  writeFileSync(
    join(repo, ".ai-native.yml"),
    `schemaVersion: 1\ntool: spooner\nversion: "${TOOL_VERSION}"\nstages:\n  2:\n    date: "2026-08-04"\n    templateVersion: "${version}"\n    files:\n      - "${file}"\n  3:\n    date: "2026-08-04"\n    templateVersion: "${version}"\n    files:\n      - "AGENTS.md"\n`,
  );
}

function statusOf(repo: string, file: string): string {
  const r = run(repo, true);
  return r.files.find((f) => f.file === file)?.status ?? "absent";
}

test("up-to-date: installed bytes == current template", () => {
  const repo = fixture();
  const tpl = join(repo, ".pre-commit-config.yaml");
  writeManifest(repo, TOOL_VERSION, ".pre-commit-config.yaml");
  writeFileSync(tpl, readTemplate("pre-commit-config.yaml"));
  assert.equal(statusOf(repo, ".pre-commit-config.yaml"), "up-to-date");
  rmSync(repo, { recursive: true, force: true });
});

test("outdated: older recorded version + differing bytes -> outdated with version pair", () => {
  const repo = fixture();
  writeManifest(repo, "0.0.9", ".pre-commit-config.yaml");
  writeFileSync(join(repo, ".pre-commit-config.yaml"), readTemplate("pre-commit-config.yaml") + "# drift\n");
  const r = run(repo, true);
  const f = r.files.find((x) => x.file === ".pre-commit-config.yaml");
  assert.equal(f?.status, "outdated");
  assert.equal(f?.from, "0.0.9");
  assert.equal(f?.to, TOOL_VERSION);
  rmSync(repo, { recursive: true, force: true });
});

test("modified: same-version user edit -> never touched", () => {
  const repo = fixture();
  writeManifest(repo, TOOL_VERSION, ".pre-commit-config.yaml");
  writeFileSync(join(repo, ".pre-commit-config.yaml"), readTemplate("pre-commit-config.yaml") + "# user edit\n");
  assert.equal(statusOf(repo, ".pre-commit-config.yaml"), "modified");
  rmSync(repo, { recursive: true, force: true });
});

test("missing: manifest records it, file gone -> missing", () => {
  const repo = fixture();
  writeManifest(repo, "0.2.2", ".pre-commit-config.yaml");
  assert.equal(statusOf(repo, ".pre-commit-config.yaml"), "missing");
  rmSync(repo, { recursive: true, force: true });
});

test("generated: AGENTS.md is not template-managed (never written)", () => {
  const repo = fixture();
  writeManifest(repo, "0.2.2", ".pre-commit-config.yaml");
  writeFileSync(join(repo, "AGENTS.md"), "# x\n");
  assert.equal(statusOf(repo, "AGENTS.md"), "generated");
  rmSync(repo, { recursive: true, force: true });
});

test("no manifest: report says run transform stage 2 first", () => {
  const repo = fixture();
  const r = run(repo, true);
  assert.equal(r.files.length, 0);
  assert.match(r.message ?? "", /run transform stage 2 first/);
  rmSync(repo, { recursive: true, force: true });
});
