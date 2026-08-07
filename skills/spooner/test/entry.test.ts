import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT_DIR = join(REPO_ROOT, "skills", "spooner", "scripts");
const SCRIPTS = ["detect.ts", "audit.ts", "transform.ts", "check.ts", "sync.ts", "badge.ts"];

test("entry guard: all scripts delegate to isDirectEntry — no raw path equality", () => {
  for (const name of SCRIPTS) {
    const src = readFileSync(join(SCRIPT_DIR, name), "utf8");
    assert.match(src, /isDirectEntry\(import\.meta\.url\)/, `${name} must use the shared guard`);
    assert.doesNotMatch(
      src,
      /fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]/,
      `${name} must not compare raw paths`,
    );
  }
});

test(
  "entry guard: script runs main when invoked through a symlinked directory",
  { skip: process.platform === "win32" },
  () => {
    const tmp = mkdtempSync(join(tmpdir(), "spooner-entry-"));
    try {
      const link = join(tmp, "repo-link");
      symlinkSync(REPO_ROOT, link, "dir");
      const r = spawnSync(process.execPath, [join(link, "skills/spooner/scripts/detect.ts"), "--root", REPO_ROOT], {
        encoding: "utf8",
      });
      assert.equal(r.status, 0, `exit ${r.status} — stderr: ${r.stderr}`);
      assert.ok(r.stdout.trim().length > 0, "silent exit 0 — guard compared non-real paths (pre-fix behavior)");
      assert.ok(Array.isArray(JSON.parse(r.stdout).stacks), "expected a detect report");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test("entry guard: relative script path from the repo root runs main", () => {
  const r = spawnSync(process.execPath, ["skills/spooner/scripts/detect.ts", "--root", REPO_ROOT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.trim().length > 0);
});
