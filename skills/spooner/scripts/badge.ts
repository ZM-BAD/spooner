#!/usr/bin/env node
/**
 * badge — Spooner M9: render a deterministic shields-style readiness badge.
 *
 * Re-runs the audit (the badge never shows a stale score), renders a
 * shields-style SVG (flat / flat-square / plastic / for-the-badge / social),
 * probes the root README and matches the dominant existing badge style
 * (majority of recognized shields.io `style=` values; no signal or tie ->
 * flat — consistency > freshness). `--style` always overrides the probe.
 *
 * Writes only the two declared artifacts (assets/badge.svg +
 * assets/audit-report.md — the badge links to the report: every point
 * carries evidence) and prints the README insertion snippet + probe
 * evidence. Never modifies the README itself.
 *
 * Zero dependencies (Node builtins only); runs natively via Node's
 * type stripping — no build step:
 *   node skills/spooner/scripts/badge.ts [--root <path>] [--style <name>] [--format json|markdown]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAudit, renderMarkdown as renderAuditMarkdown } from "./audit.ts";

const ARTIFACT_DIR = "assets";
const BADGE_FILE = "badge.svg";
const REPORT_FILE = "audit-report.md";
const SCHEMA_VERSION = 1;

// Pinned style set + tier/color mapping (spec 0009).
export const STYLES = ["flat", "flat-square", "plastic", "for-the-badge", "social"] as const;
export type Style = (typeof STYLES)[number];

const TIERS: readonly { label: string; min: number }[] = [
  { label: "AI-Native", min: 17 },
  { label: "AI-Friendly", min: 13 },
  { label: "AI-Curious", min: 9 },
  { label: "AI-Aware", min: 5 },
  { label: "AI-Absent", min: 0 },
];

const COLOR_GREEN = "#4c1";
const COLOR_YELLOW = "#dfb317";
const COLOR_RED = "#e05d44";

/** Tier label for a score (spec 0009, pinned). */
export function tierOf(score: number): string {
  const tier = TIERS.find((t) => score >= t.min);
  return tier ? tier.label : TIERS[TIERS.length - 1].label;
}

/** Message-side color for a score (spec 0009, pinned). */
export function colorOf(score: number): string {
  if (score >= 16) return COLOR_GREEN;
  if (score >= 10) return COLOR_YELLOW;
  return COLOR_RED;
}

// --- README style probe -------------------------------------------------------

interface BadgeHit {
  url: string;
  style: Style | null;
}

export interface ProbeResult {
  readme: string | null;
  badges: BadgeHit[];
  counts: Record<string, number>;
  decided: Style;
  source: "probe" | "default";
  evidence: string;
}

/** Extract badge image URLs (markdown images + <img> tags) from the root README. */
function badgeUrls(readme: string | null): string[] {
  if (!readme) return [];
  const urls: string[] = [];
  for (const m of readme.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)) urls.push(m[1]);
  for (const m of readme.matchAll(/<img[^>]*src="([^"]+)"/gi)) urls.push(m[1]);
  return urls;
}

/**
 * Probe the root README for existing badges. Known style signal = a
 * shields.io URL with a `style=` value from the official set; anything
 * else (badgen, custom SVG, GitHub-native workflow badges) is unknown.
 */
export function probeReadme(root: string): ProbeResult {
  const readmePath = join(root, "README.md");
  const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : null;

  const badges: BadgeHit[] = badgeUrls(readme).map((url) => {
    const m = url.match(/[?&]style=([a-z0-9-]+)/i);
    const style = m && (STYLES as readonly string[]).includes(m[1]) ? (m[1] as Style) : null;
    return { url, style };
  });

  const counts: Record<string, number> = {};
  for (const b of badges) {
    if (b.style) counts[b.style] = (counts[b.style] ?? 0) + 1;
  }

  // Decision chain (spec 0009): strict majority of known styles, else flat.
  let majority: Style | null = null;
  let best = 0;
  for (const [style, n] of Object.entries(counts)) {
    if (n > best) {
      best = n;
      majority = style as Style;
    }
  }
  const tied = Object.values(counts).filter((n) => n === best).length > 1;
  const matched = best > 0 && !tied;
  const decided: Style = matched && majority ? majority : "flat";
  const source: ProbeResult["source"] = matched ? "probe" : "default";

  const known = badges.filter((b) => b.style !== null).length;
  const evidence = !readme
    ? "README.md missing — default flat"
    : badges.length === 0
      ? "no badges found in README.md — default flat"
      : known === 0
        ? `no recognized shields.io style among ${badges.length} badge(s) — default flat`
        : matched
          ? `matched ${decided}: ${best} shields.io badge(s)`
          : "tie between existing styles — default flat";

  return { readme: readme ? readmePath : null, badges, counts, decided, source, evidence };
}

// --- SVG rendering ------------------------------------------------------------

interface StyleSpec {
  height: number;
  fontSize: number;
  padding: number;
  radius: number;
  labelColor: string;
  textColor: string;
  bold: boolean;
  uppercase: boolean;
  gradient: boolean;
  gloss: boolean;
  shadowText: boolean;
}

const STYLE_SPECS: Record<Style, StyleSpec> = {
  // The shields.io official set (spec 0009). "shields-style" geometry, not
  // pixel parity: 20px height, 11px Verdana, pill, grey label + colored
  // message (flat / flat-square / plastic / for-the-badge); social is
  // supported for parity but semantically a count-button style.
  flat: { height: 20, fontSize: 11, padding: 6, radius: 3, labelColor: "#555", textColor: "#fff", bold: false, uppercase: false, gradient: true, gloss: false, shadowText: true },
  "flat-square": { height: 20, fontSize: 11, padding: 6, radius: 0, labelColor: "#555", textColor: "#fff", bold: false, uppercase: false, gradient: false, gloss: false, shadowText: false },
  plastic: { height: 20, fontSize: 11, padding: 6, radius: 3, labelColor: "#555", textColor: "#fff", bold: false, uppercase: false, gradient: true, gloss: true, shadowText: true },
  "for-the-badge": { height: 28, fontSize: 15, padding: 16, radius: 4, labelColor: "#555", textColor: "#fff", bold: true, uppercase: true, gradient: false, gloss: false, shadowText: false },
  social: { height: 20, fontSize: 11, padding: 6, radius: 4, labelColor: "#e9e9e9", textColor: "#333", bold: false, uppercase: false, gradient: false, gloss: false, shadowText: false },
};

/** Approximate per-character widths for Verdana 11px (shields conventions). */
const FONT_WIDTHS: Record<string, number> = {
  " ": 3.4, "!": 4.2, "\"": 4.9, "#": 8.2, "$": 6.6, "%": 10.2, "&": 8.3, "'": 3.0, "(": 4.3, ")": 4.3,
  "*": 4.6, "+": 7.0, ",": 3.4, "-": 4.2, ".": 3.4, "/": 4.2, ":": 3.4, ";": 3.4, "<": 7.0, "=": 7.0,
  ">": 7.0, "?": 6.2, "@": 11.5, "[": 4.3, "\\": 4.2, "]": 4.3, "^": 6.4, "_": 6.6, "`": 4.6,
  "A": 8.0, "B": 7.9, "C": 8.1, "D": 8.6, "E": 7.5, "F": 7.0, "G": 8.8, "H": 8.8, "I": 4.1, "J": 4.8,
  "K": 8.1, "L": 6.8, "M": 10.1, "N": 8.8, "O": 9.0, "P": 7.6, "Q": 9.0, "R": 8.0, "S": 7.0, "T": 7.4,
  "U": 8.3, "V": 8.0, "W": 11.4, "X": 8.0, "Y": 8.0, "Z": 7.4,
  "a": 6.6, "b": 6.9, "c": 5.9, "d": 6.9, "e": 6.5, "f": 4.1, "g": 6.9, "h": 7.0, "i": 3.2, "j": 3.2,
  "k": 6.3, "l": 3.2, "m": 10.8, "n": 7.0, "o": 6.9, "p": 6.9, "q": 6.9, "r": 4.7, "s": 5.7, "t": 4.1,
  "u": 7.0, "v": 6.5, "w": 9.6, "x": 6.3, "y": 6.5, "z": 5.8, "{": 5.0, "|": 4.2, "}": 5.0, "~": 7.0,
};

/** Approximate rendered width in px (11px base; scales with font size). */
function textWidth(text: string, fontSize: number, bold: boolean): number {
  let sum = 0;
  for (const ch of text) sum += FONT_WIDTHS[ch] ?? 7;
  return (sum * (bold ? 1.08 : 1) * fontSize) / 11;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render a shields-style badge SVG (label = tier, message = score). */
export function renderBadge(label: string, message: string, style: Style, messageColor: string): string {
  const spec = STYLE_SPECS[style];
  const displayLabel = spec.uppercase ? label.toUpperCase() : label;
  const displayMsg = spec.uppercase ? message.toUpperCase() : message;
  const labelW = Math.ceil(textWidth(displayLabel, spec.fontSize, spec.bold) + spec.padding * 2);
  const msgW = Math.ceil(textWidth(displayMsg, spec.fontSize, spec.bold) + spec.padding * 2);
  const width = labelW + msgW;
  const height = spec.height;
  const textY = height - 5;
  const labelX = labelW / 2;
  const msgX = labelW + msgW / 2;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="${escapeXml(label)}: ${escapeXml(message)}">`,
  );
  parts.push(`<title>${escapeXml(label)}: ${escapeXml(message)}</title>`);
  if (spec.gradient) {
    parts.push('<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>');
  }
  if (spec.gloss) {
    parts.push('<linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".15"/><stop offset="1" stop-opacity="0"/></linearGradient>');
  }
  parts.push(`<clipPath id="r"><rect width="${width}" height="${height}" rx="${spec.radius}" fill="#fff"/></clipPath>`);
  parts.push('<g clip-path="url(#r)">');
  parts.push(`<rect width="${labelW}" height="${height}" fill="${spec.labelColor}"/>`);
  parts.push(`<rect x="${labelW}" width="${msgW}" height="${height}" fill="${messageColor}"/>`);
  if (spec.gradient) parts.push(`<rect width="${width}" height="${height}" fill="url(#s)"/>`);
  if (spec.gloss) parts.push(`<rect width="${width}" height="${height}" fill="url(#g)"/>`);
  parts.push("</g>");
  const font = `font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="${spec.fontSize}"${spec.bold ? ' font-weight="bold"' : ""}`;
  parts.push(`<g fill="${spec.textColor}" text-anchor="middle" ${font}>`);
  if (spec.shadowText) {
    parts.push(`<text aria-hidden="true" x="${labelX}" y="${textY + 1}" fill="#010101" fill-opacity=".3">${escapeXml(displayLabel)}</text>`);
    parts.push(`<text aria-hidden="true" x="${msgX}" y="${textY + 1}" fill="#010101" fill-opacity=".3">${escapeXml(displayMsg)}</text>`);
  }
  parts.push(`<text x="${labelX}" y="${textY}">${escapeXml(displayLabel)}</text>`);
  parts.push(`<text x="${msgX}" y="${textY}">${escapeXml(displayMsg)}</text>`);
  parts.push("</g>", "</svg>");
  return `${parts.join("\n")}\n`;
}

// --- pipeline -----------------------------------------------------------------

export interface BadgeReport {
  schemaVersion: number;
  root: string;
  score: { total: number; max: number };
  tier: string;
  style: { used: Style; source: "override" | "probe" | "default"; counts: Record<string, number> };
  probe: ProbeResult;
  files: { badge: string; report: string };
  snippet: string;
}

/** Full badge pipeline: audit -> probe -> render -> write the two artifacts. */
export function run(root: string, override: Style | null): BadgeReport {
  const audit = runAudit(root);
  const probe = probeReadme(root);
  const used = override ?? probe.decided;
  const source: BadgeReport["style"]["source"] = override ? "override" : probe.source;
  const tier = tierOf(audit.score.total);
  const message = `${audit.score.total}/${audit.score.max}`;
  const svg = renderBadge(tier, message, used, colorOf(audit.score.total));

  mkdirSync(join(root, ARTIFACT_DIR), { recursive: true });
  const badgePath = join(ARTIFACT_DIR, BADGE_FILE);
  const reportPath = join(ARTIFACT_DIR, REPORT_FILE);
  writeFileSync(join(root, badgePath), svg, "utf8");
  writeFileSync(join(root, reportPath), renderAuditMarkdown(audit), "utf8");

  const snippet = `[![${tier} ${message}](${badgePath})](${reportPath})`;
  return {
    schemaVersion: SCHEMA_VERSION,
    root: ".",
    score: { total: audit.score.total, max: audit.score.max },
    tier,
    style: { used, source, counts: probe.counts },
    probe,
    files: { badge: badgePath, report: reportPath },
    snippet,
  };
}

// --- rendering -----------------------------------------------------------------

function renderMarkdown(r: BadgeReport): string {
  const lines: string[] = ["# Badge Report", ""];
  lines.push(`- Score: **${r.score.total}/${r.score.max}** · Tier: ${r.tier} · Style: ${r.style.used} (${r.style.source})`, "");
  lines.push(`- Probe: ${r.probe.evidence}`, "");
  lines.push(`- Badge: \`${r.files.badge}\` · Report: \`${r.files.report}\``, "");
  lines.push("", "## README snippet", "");
  lines.push("", r.snippet, "");
  return lines.join("\n");
}

// --- CLI ------------------------------------------------------------------------

function parseArgs(argv: string[]): { root: string; style: Style | null; format: "json" | "markdown" } {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const format = valueOf("--format") === "markdown" ? "markdown" : "json";
  return { root: valueOf("--root") ?? process.cwd(), style: null, format };
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
      `badge: Node.js >= 22.18 required (native type stripping); found ${process.versions.node}.\n` +
        "Upgrade Node, e.g. via your version manager (nvm install --lts).",
    );
    process.exit(1);
  }
}

// CLI entry: runs only when executed directly (importing must not trigger side effects)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  assertNodeVersion();
  const args = parseArgs(process.argv.slice(2));
  const styleRaw = (() => {
    const i = process.argv.indexOf("--style");
    return i >= 0 ? process.argv[i + 1] : undefined;
  })();
  if (styleRaw !== undefined && !(STYLES as readonly string[]).includes(styleRaw)) {
    console.error(`badge: unknown style "${styleRaw}" — valid: ${STYLES.join(", ")}`);
    process.exit(1);
  }
  try {
    const report = run(args.root, (styleRaw as Style | undefined) ?? null);
    process.stdout.write(args.format === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    console.error(`badge: failed to scan ${args.root}: ${(err as Error).message}`);
    process.exit(1);
  }
}
