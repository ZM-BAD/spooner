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

test("probe: lowercase readme.md probes identically (case-insensitive lookup)", () => {
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

test("probe: single-quoted <img src='...'> is detected too", () => {
  const repo = fixture();
  writeReadme(repo, `<img src='${SHIELDS}/x-y?style=flat-square' alt="p">\n`);
  const p = probeReadme(repo);
  assert.equal(p.decided, "flat-square");
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
  // review round (2026-08-16): real contract, not a tautology — the badge
  // message must be "x/10" (spec 0013 AC13), pinned via the rendered SVG.
  assert.equal(typeof report.score.total, "number");
  assert.match(svg, /aria-label="[^"]*\/10"/, `badge message must be x/10: ${svg.slice(0, 120)}`);
  // badge revision (spec 0009): the label is the fixed metric, never the
  // tier — a morphing label made the badge's identity unstable and disagreed
  // with the color bands; the tier stays in the report + README table.
  assert.match(svg, /aria-label="AI-Readiness: [^"]*\/10"/, `fixed label: ${svg.slice(0, 120)}`);
  assert.ok(report.snippet.includes("AI-Readiness"), `snippet uses the fixed label: ${report.snippet}`);
  assert.doesNotMatch(svg, /AI-Native|AI-Friendly|AI-Curious|AI-Aware|AI-Absent/, "badge never shows a tier name");
  assert.equal(report.tier, tierOf(report.score.total), "the tier stays a report concept");
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
  // aria-label/title follow the displayed uppercase text
  assert.match(svg, /aria-label="AI-FRIENDLY: 16\/20"/);
  assert.match(svg, /<title>AI-FRIENDLY: 16\/20<\/title>/);
});

test("renderBadge: all five styles render without error", () => {
  for (const style of ["flat", "flat-square", "plastic", "for-the-badge", "social"] as const) {
    const svg = renderBadge("AI-Aware", "7/20", style, "#e05d44");
    assert.match(svg, /^<svg /);
    assert.ok(svg.trimEnd().endsWith("</svg>"));
  }
});

// --- showcase asset geometry (spec 0009 revision) -----------------------------

test("before-after.svg: label+score adjacent, arrow clears both cards by >= 15px", () => {
  // review rounds: hand-estimated gaps first put the arrow glyph (34px box
  // at font-size 34) 7px into the before card, then a 10px seam appeared
  // between the label and score blocks (the generated badge has none) —
  // both measured in-browser at a 375px viewport. Pinned here so a layout
  // drift fails loudly.
  const svg = readFileSync(new URL("../../../assets/before-after.svg", import.meta.url), "utf8");
  assert.match(svg, /viewBox="0 0 640 150"/, "viewBox keeps the aspect ratio under CSS scaling");
  const msg = svg.match(/<rect x="(\d+(?:\.\d+)?)" y="30" width="(\d+)" height="48" rx="6" fill="#e05d44"/);
  const afterMsg = svg.match(/<rect x="(\d+(?:\.\d+)?)" y="30" width="(\d+)" height="48" rx="6" fill="#4c1"/);
  const arrow = svg.match(/<text x="(\d+(?:\.\d+)?)" y="64"[^>]*>→</);
  const greyRects = svg.match(/<rect x="(\d+(?:\.\d+)?)" y="30" width="\d+" height="48" rx="6" fill="#555"/g);
  assert.ok(msg && afterMsg && arrow && greyRects?.length === 2, "cards, arrow and both label rects present");
  const beforeLabel = greyRects[0].match(/x="(\d+(?:\.\d+)?)" y="30" width="(\d+)"/)!;
  const afterLabel = greyRects[1].match(/x="(\d+(?:\.\d+)?)" y="30" width="(\d+)"/)!;
  const beforeLabelEnd = Number(beforeLabel[1]) + Number(beforeLabel[2]);
  const afterLabelEnd = Number(afterLabel[1]) + Number(afterLabel[2]);
  // label and score blocks are adjacent, like the generated badge
  assert.equal(Number(msg[1]), beforeLabelEnd, "before label and score must be adjacent (no seam)");
  assert.equal(Number(afterMsg[1]), afterLabelEnd, "after label and score must be adjacent (no seam)");
  const msgEnd = Number(msg[1]) + Number(msg[2]);
  const arrowX = Number(arrow[1]);
  const afterLabelX = Number(afterLabel[1]);
  assert.ok(arrowX - msgEnd >= 15, `arrow must clear the before card: msg ends ${msgEnd}, arrow at ${arrowX}`);
  assert.ok(
    afterLabelX - arrowX >= 15,
    `arrow must clear the after card: arrow at ${arrowX}, label starts ${afterLabelX}`,
  );
});
