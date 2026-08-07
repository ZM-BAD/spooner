import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { colorOf, probeReadme, renderBadge, run, tierOf } from "../scripts/badge.ts";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "spooner-badge-"));
}

function writeReadme(dir: string, content: string): void {
  writeFileSync(join(dir, "README.md"), content);
}

const SHIELDS = "https://img.shields.io/badge";

// --- README style probe (spec 0009 decision chain) ----------------------------

test("probe: no README -> default flat", () => {
  const repo = fixture();
  const p = probeReadme(repo);
  assert.equal(p.readme, null);
  assert.equal(p.decided, "flat");
  assert.equal(p.source, "default");
  assert.equal(p.evidence, "README missing — default flat");
  rmSync(repo, { recursive: true, force: true });
});

test("probe: lowercase readme.md probes identically (case-insensitive lookup, 2026-08-07)", () => {
  const repo = fixture();
  writeFileSync(
    join(repo, "readme.md"),
    "# R\n\n![x](https://img.shields.io/badge/a-1-flat?style=flat-square)\n![y](https://img.shields.io/badge/b-2-flat?style=flat-square)\n",
  );
  const p = probeReadme(repo);
  assert.equal(p.decided, "flat-square");
  assert.equal(p.source, "probe");
  assert.match(p.evidence, /matched flat-square/);
  rmSync(repo, { recursive: true, force: true });
});

test("probe: README without badges -> default flat", () => {
  const repo = fixture();
  writeReadme(repo, "# Demo\n\nNo badges here.\n");
  const p = probeReadme(repo);
  assert.equal(p.decided, "flat");
  assert.equal(p.source, "default");
  rmSync(repo, { recursive: true, force: true });
});

test("probe: >= 2 shields flat-square badges -> flat-square matched", () => {
  const repo = fixture();
  writeReadme(repo, `# Demo\n\n![a](${SHIELDS}/a-a?style=flat-square)\n![b](${SHIELDS}/b-b?style=flat-square)\n`);
  const p = probeReadme(repo);
  assert.equal(p.decided, "flat-square");
  assert.equal(p.source, "probe");
  assert.equal(p.evidence, "matched flat-square: 2 shields.io badge(s)");
  rmSync(repo, { recursive: true, force: true });
});

test("probe: mixed known styles -> strict majority wins", () => {
  const repo = fixture();
  writeReadme(
    repo,
    `# Demo\n\n![a](${SHIELDS}/a-a?style=flat)\n![b](${SHIELDS}/b-b?style=flat)\n![c](${SHIELDS}/c-c?style=for-the-badge)\n`,
  );
  const p = probeReadme(repo);
  assert.equal(p.decided, "flat");
  assert.equal(p.source, "probe");
  rmSync(repo, { recursive: true, force: true });
});

test("probe: tie between known styles -> default flat", () => {
  const repo = fixture();
  writeReadme(repo, `# Demo\n\n![a](${SHIELDS}/a-a?style=flat)\n![b](${SHIELDS}/b-b?style=flat-square)\n`);
  const p = probeReadme(repo);
  assert.equal(p.decided, "flat");
  assert.equal(p.source, "default");
  assert.equal(p.evidence, "tie between existing styles — default flat");
  rmSync(repo, { recursive: true, force: true });
});

test("probe: non-shields badges only -> default flat", () => {
  const repo = fixture();
  writeReadme(repo, "# Demo\n\n![a](https://badgen.net/badge/a/b)\n![b](assets/logo.svg)\n");
  const p = probeReadme(repo);
  assert.equal(p.decided, "flat");
  assert.equal(p.source, "default");
  assert.match(p.evidence, /no recognized shields\.io style/);
  rmSync(repo, { recursive: true, force: true });
});

test("probe: <img> tags are detected too", () => {
  const repo = fixture();
  writeReadme(repo, `<p align="center"><img src="${SHIELDS}/x-y?style=plastic" alt="p"></p>\n`);
  const p = probeReadme(repo);
  assert.equal(p.decided, "plastic");
  assert.equal(p.source, "probe");
  rmSync(repo, { recursive: true, force: true });
});

// --- style override -------------------------------------------------------------

test("run: --style override wins and probe evidence is still reported", () => {
  const repo = fixture();
  writeReadme(repo, `# Demo\n\n![a](${SHIELDS}/a-a?style=flat-square)\n`);
  const report = run(repo, "for-the-badge");
  assert.equal(report.style.used, "for-the-badge");
  assert.equal(report.style.source, "override");
  assert.equal(report.probe.decided, "flat-square");
  assert.match(report.probe.evidence, /matched flat-square/);
  rmSync(repo, { recursive: true, force: true });
});

// --- artifacts + determinism -----------------------------------------------------

test("run: writes both artifacts and the snippet references them", () => {
  const repo = fixture();
  writeReadme(repo, "# Demo\n\nSome content that exceeds fifty characters so struct-readme scores.\n");
  const report = run(repo, null);
  const svg = readFileSync(join(repo, "assets", "badge.svg"), "utf8");
  const md = readFileSync(join(repo, "assets", "audit-report.md"), "utf8");
  assert.match(svg, /^<svg /);
  assert.match(md, /^# AI-Readiness Report/);
  assert.equal(report.files.badge, "assets/badge.svg");
  assert.equal(report.files.report, "assets/audit-report.md");
  assert.ok(report.snippet.includes("assets/badge.svg"));
  assert.ok(report.snippet.includes("assets/audit-report.md"));
  assert.equal(report.score.total, report.score.total); // score always present
  assert.equal(report.tier, tierOf(report.score.total));
  rmSync(repo, { recursive: true, force: true });
});

test("run: deterministic — two runs produce identical bytes", () => {
  const repo = fixture();
  writeReadme(repo, `# Demo\n\n![a](${SHIELDS}/a-a?style=flat)\n![b](${SHIELDS}/b-b?style=flat)\n`);
  const first = run(repo, null);
  const svg1 = readFileSync(join(repo, "assets", "badge.svg"), "utf8");
  const second = run(repo, null);
  const svg2 = readFileSync(join(repo, "assets", "badge.svg"), "utf8");
  assert.equal(svg1, svg2);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  rmSync(repo, { recursive: true, force: true });
});

// --- tier/color mapping (spec 0009, pinned) ---------------------------------------

test("tierOf: pinned bands (10-scale; 9.5 = excellent benchmark, 10 almost unreachable)", () => {
  assert.equal(tierOf(10), "AI-Native");
  assert.equal(tierOf(9), "AI-Native");
  assert.equal(tierOf(8.9), "AI-Friendly");
  assert.equal(tierOf(7), "AI-Friendly");
  assert.equal(tierOf(6.9), "AI-Curious");
  assert.equal(tierOf(5), "AI-Curious");
  assert.equal(tierOf(4.9), "AI-Aware");
  assert.equal(tierOf(3), "AI-Aware");
  assert.equal(tierOf(2.9), "AI-Absent");
  assert.equal(tierOf(0), "AI-Absent");
});

test("colorOf: pinned bands (M13 re-map)", () => {
  assert.equal(colorOf(9), "#4c1");
  assert.equal(colorOf(8), "#4c1");
  assert.equal(colorOf(7.9), "#dfb317");
  assert.equal(colorOf(5), "#dfb317");
  assert.equal(colorOf(4.9), "#e05d44");
  assert.equal(colorOf(0), "#e05d44");
});

// --- SVG rendering -----------------------------------------------------------------

test("renderBadge: valid structure, adaptive width, pinned style geometry", () => {
  const flat = renderBadge("AI-Native", "18/20", "flat", "#4c1");
  assert.match(flat, /^<svg /);
  assert.ok(flat.trimEnd().endsWith("</svg>"));
  assert.doesNotMatch(flat, /NaN|undefined/);
  const width = Number(flat.match(/width="(\d+)"/)![1]);
  const label = flat.match(/<rect width="(\d+)" height="20" fill="#555"/)![1];
  assert.ok(width > Number(label)); // message side adds width (adaptive, not fixed)
  assert.match(flat, /rx="3"/); // flat = rounded
  assert.match(flat, /aria-label="AI-Native: 18\/20"/);
});

test("renderBadge: flat-square has square corners, no shadow text", () => {
  const svg = renderBadge("AI-Native", "18/20", "flat-square", "#4c1");
  assert.match(svg, /rx="0"/);
  assert.doesNotMatch(svg, /fill-opacity="\.3"/);
});

test("renderBadge: for-the-badge is big, bold, uppercase", () => {
  const svg = renderBadge("AI-Friendly", "16/20", "for-the-badge", "#4c1");
  assert.match(svg, /height="28"/);
  assert.match(svg, /font-weight="bold"/);
  assert.match(svg, />AI-FRIENDLY</);
  assert.match(svg, />16\/20</);
});

test("renderBadge: all five styles render without error", () => {
  for (const style of ["flat", "flat-square", "plastic", "for-the-badge", "social"] as const) {
    const svg = renderBadge("AI-Aware", "7/20", style, "#e05d44");
    assert.match(svg, /^<svg /);
    assert.ok(svg.trimEnd().endsWith("</svg>"));
  }
});
