import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../scripts/check.ts";

/** Fresh fixture repo (not a git repo — freshness/maturity checks just under-score). */
function fixture(): string {
  return mkdtempSync(join(tmpdir(), "spooner-check-"));
}

test("check: first run records a v2 baseline with the note", () => {
  const repo = fixture();
  const r1 = run(repo);
  assert.equal(r1.schemaVersion, 2);
  assert.equal(r1.baseline.present, false);
  assert.match(r1.suggestions.join(" "), /First check — baseline recorded/);
  const baseline = JSON.parse(readFileSync(join(repo, ".ai-native", "baseline.json"), "utf8"));
  assert.equal(baseline.schemaVersion, 2);
  assert.equal(baseline.score.max, 10);
  rmSync(repo, { recursive: true, force: true });
});

test("check: second run reports delta 0 with unchanged wording", () => {
  const repo = fixture();
  run(repo);
  const r2 = run(repo);
  assert.equal(r2.baseline.present, true);
  assert.equal(r2.baseline.delta, 0);
  assert.match(r2.suggestions.join(" "), /Readiness unchanged/);
  rmSync(repo, { recursive: true, force: true });
});

test("check: v1-model baseline is re-baselined with an explicit notice", () => {
  const repo = fixture();
  mkdirSync(join(repo, ".ai-native"), { recursive: true });
  writeFileSync(join(repo, ".ai-native", "baseline.json"), JSON.stringify({ schemaVersion: 1, date: "2026-08-01", score: { total: 18, max: 20 }, gaps: [] }) + "\n");
  const r = run(repo);
  assert.equal(r.baseline.present, false);
  assert.match(r.suggestions.join(" "), /v1 scoring model re-baselined/);
  const baseline = JSON.parse(readFileSync(join(repo, ".ai-native", "baseline.json"), "utf8"));
  assert.equal(baseline.schemaVersion, 2);
  rmSync(repo, { recursive: true, force: true });
});

test("check: score drop surfaces a negative delta", () => {
  const repo = fixture();
  writeFileSync(join(repo, "README.md"), "# R\n\n## A\n\n## B\n\n## C\n\nbody body body\n");
  const first = run(repo);
  rmSync(join(repo, "README.md"));
  const second = run(repo);
  assert.ok((second.baseline.delta ?? 0) < 0, `expected negative delta, got ${second.baseline.delta}`);
  assert.match(second.suggestions.join(" "), /dropped/);
  assert.ok(first.score.total > second.score.total);
  rmSync(repo, { recursive: true, force: true });
});
