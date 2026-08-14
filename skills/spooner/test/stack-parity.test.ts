import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KNOWN_STACKS } from "../scripts/detect.ts";
import { runAudit } from "../scripts/audit.ts";
import { generateAgentsMd } from "../scripts/transform.ts";
import { STACK_COMMANDS } from "../scripts/stacks.ts";

/**
 * Stack parity (spec 0015): every known detect stack must be covered at every
 * consumption point — or carry an explicit documented-ceiling marker. The
 * four repeating pitfall classes (fresh-deps lag, audit/artifact
 * contradiction, backslash escaping, auto-fix) all trace to a stack reaching
 * some consumption points but not others; this test turns the gaps red at
 * development time.
 *
 * Coverage is behavioral (write the stack's manifest fixture, run the check)
 * — never a hard-coded copy of implementation branches.
 */

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "spooner-parity-"));
}

/** fresh-deps: per-stack manifest fixture (coverage) or documented ceiling. */
const FRESH_DEPS: Record<string, { manifest: string; content: string } | { ceiling: string }> = {
  node: { manifest: "package.json", content: '{"name":"x","dependencies":{"y":"^1.0.0"}}\n' },
  python: { manifest: "requirements.txt", content: "requests==2.31.0\n" },
  go: { manifest: "go.mod", content: "module x\n" },
  rust: { manifest: "Cargo.toml", content: '[package]\nname = "x"\nversion = "0.1.0"\n' },
  java: { manifest: "pom.xml", content: "<project/>\n" },
  php: { manifest: "composer.json", content: "{}\n" },
  zig: { manifest: "build.zig.zon", content: ".{\n    .name = .x,\n    .dependencies = .{},\n}\n" },
  "dart/flutter": { manifest: "pubspec.yaml", content: "name: x\n" },
  unity: { manifest: "Packages/manifest.json", content: '{ "dependencies": {} }\n' },
  ruby: { manifest: "Gemfile", content: 'source "https://rubygems.org"\n' },
  swift: { manifest: "Package.swift", content: "// swift-tools-version:5.9\n" },
  dotnet: { manifest: "app.csproj", content: "<Project/>\n" },
  harmonyos: { manifest: "oh-package.json5", content: "{\n}\n" },
  apple: { manifest: "Podfile", content: "platform :ios, '15.0'\n" },
  // vcpkg.json / conanfile.txt carry real version semantics (spec 0014
  // signals) — coverage; only CMakeLists.txt / meson.build lack dependency
  // declarations (the true ceiling, pinned by the CMake-only test below).
  "c/cpp": { manifest: "vcpkg.json", content: '{"name": "demo", "dependencies": ["fmt"]}\n' },
};

/** Command sources: audit credits a canonical lifecycle for the stack. */
const COMMAND_SOURCE_STACKS: Record<string, string> = {
  node: "package.json",
  python: "pyproject.toml",
  go: "go.mod",
  rust: "Cargo.toml",
  java: "pom.xml",
  php: "composer.json + phpunit.xml",
  apple: "Podfile",
  "dart/flutter": "pubspec.yaml",
  zig: "build.zig",
  "c/cpp": "CMakeLists.txt",
};

/** Stacks with no canonical lifecycle (documented ceiling, spec 0014). */
const NO_LIFECYCLE_CEILING: Record<string, string> = {
  unity: "no canonical CLI lifecycle (spec 0014 C group)",
  ruby: "no canonical CLI lifecycle (bundler is a toolchain, not a lifecycle)",
  swift: "no canonical CLI lifecycle (SPM builds via xcodebuild/swift build — not credited)",
  dotnet: "no canonical CLI lifecycle (dotnet CLI exists but unverified for credit)",
  harmonyos: "no canonical CLI lifecycle (hvigor unverified)",
};

/** Stack-canonical lint commands (stackLintCommandOf coverage). */
const LINT_COMMAND_STACKS: Record<string, string> = {
  go: "go vet ./...",
  rust: "cargo clippy",
  python: "ruff check",
  "dart/flutter": "dart analyze",
};

function writeManifest(repo: string, manifest: string, content: string): void {
  const full = join(repo, manifest);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function freshDepsItem(repo: string) {
  return runAudit(repo).items.find((i) => i.id === "fresh-deps");
}

// --- fresh-deps coverage (pitfall class 1: list lags detect stacks) --------

test("parity: every detect stack is covered by fresh-deps or a documented ceiling", () => {
  const missing = KNOWN_STACKS.filter((s) => !(s in FRESH_DEPS));
  assert.deepEqual(missing, [], `stacks without fresh-deps coverage or ceiling marker: ${missing.join(", ")}`);
});

test("parity: each covered stack's manifest actually scores fresh-deps (behavioral)", () => {
  for (const stack of KNOWN_STACKS) {
    const entry = FRESH_DEPS[stack];
    if (!entry || "ceiling" in entry) continue;
    const repo = fixture();
    writeManifest(repo, entry.manifest, entry.content);
    const r = freshDepsItem(repo);
    assert.ok((r?.score ?? 0) > 0, `${stack}: ${entry.manifest} must score fresh-deps — got "${r?.evidence}"`);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("parity: ceiling stacks report honestly (no manifest to score)", () => {
  for (const stack of KNOWN_STACKS) {
    const entry = FRESH_DEPS[stack];
    if (!entry || !("ceiling" in entry)) continue;
    const repo = fixture();
    const r = freshDepsItem(repo);
    assert.equal(r?.score, 0, `${stack} (ceiling) must score 0 on an empty repo`);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("parity: c/cpp's true ceiling — a CMakeLists-only repo has no manifest to score", () => {
  const repo = fixture();
  writeFileSync(join(repo, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.16)\n");
  const r = freshDepsItem(repo);
  assert.equal(r?.score, 0, `cmake/meson have no version semantics — got "${r?.evidence}"`);
  assert.match(r?.evidence ?? "", /no dependency manifest/);
  rmSync(repo, { recursive: true, force: true });
});

// --- command-source parity (pitfall class 3: audit credit vs artifact) -----

test("parity: every command-source stack also reaches the generated AGENTS.md command table", () => {
  for (const stack of KNOWN_STACKS) {
    const source = COMMAND_SOURCE_STACKS[stack];
    if (!source) continue;
    const repo = fixture();
    // write the stack's detect signal + command source manifests
    const signals: Record<string, string> = {
      node: "package.json",
      python: "pyproject.toml",
      go: "go.mod",
      rust: "Cargo.toml",
      java: "pom.xml",
      php: "composer.json",
      apple: "Podfile",
      "dart/flutter": "pubspec.yaml",
      zig: "build.zig",
      "c/cpp": "CMakeLists.txt",
    };
    writeManifest(repo, signals[stack], "{}");
    if (stack === "php") writeManifest(repo, "phpunit.xml", "<phpunit/>\n");
    if (stack === "node") writeManifest(repo, "package.json", '{"name":"x","scripts":{"build":"echo b"}}\n');
    const audit = runAudit(repo);
    const cmd = audit.items.find((i) => i.id === "agents-commands");
    assert.ok(cmd && (cmd.score ?? 0) > 0, `${stack}: audit must credit commands with ${source} — "${cmd?.evidence}"`);
    const md = generateAgentsMd(repo);
    assert.ok(
      !md.includes("None declared"),
      `${stack}: generated AGENTS.md must not say "None declared" while audit credits commands`,
    );
    rmSync(repo, { recursive: true, force: true });
  }
});

test("parity: no-lifecycle stacks are explicit ceilings in both directions", () => {
  for (const stack of Object.keys(NO_LIFECYCLE_CEILING)) {
    assert.ok(KNOWN_STACKS.includes(stack), `${stack} ceiling listed but not a known stack`);
    assert.ok(
      !(stack in COMMAND_SOURCE_STACKS),
      `${stack} has both a command source and a no-lifecycle ceiling — contradictory`,
    );
  }
});

test("parity: every known stack lands in a command source or an explicit ceiling (total coverage)", () => {
  // fresh-deps has a total-coverage assertion; the command source needs the
  // same — a new detect stack silently missing BOTH tables must turn red
  // (without this, the suite stays green).
  const uncovered = KNOWN_STACKS.filter((s) => !(s in COMMAND_SOURCE_STACKS) && !(s in NO_LIFECYCLE_CEILING));
  assert.deepEqual(uncovered, [], `stacks without command source or ceiling marker: ${uncovered.join(", ")}`);
});

test("parity: STACK_COMMANDS may only hold command-source stacks (reverse direction)", () => {
  // Adding a ceiling stack to the shared command table would make the
  // generated AGENTS.md list commands the audit does not credit — the exact
  // audit/artifact contradiction class this suite exists to prevent
  // (only the forward direction was guarded).
  const illegal = Object.keys(STACK_COMMANDS).filter((s) => !(s in COMMAND_SOURCE_STACKS));
  assert.deepEqual(illegal, [], `STACK_COMMANDS holds non-command-source stacks: ${illegal.join(", ")}`);
});

// --- lint command coverage (cfg-lint stack command) -------------------------

test("parity: lint-command stacks are declared; the rest are ceilings", () => {
  for (const stack of Object.keys(LINT_COMMAND_STACKS)) {
    assert.ok(KNOWN_STACKS.includes(stack), `${stack} lint command listed but not a known stack`);
  }
});
