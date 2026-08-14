#!/usr/bin/env node
/**
 * detect — Spooner M1 slice 1: project stack detection.
 *
 * Scans repository-root manifests and prints structured JSON
 * (root / detected stacks / manifest details).
 * Zero dependencies (Node builtins only); runs natively via Node's
 * type stripping — no build step:
 *   node skills/spooner/scripts/detect.ts [--root <path>]
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDirectEntry } from "./entry.ts";

/**
 * Stack signals, three kinds (spec 0014):
 * - file: exact root-path match (the M1 model)
 * - glob: top-level entries matching "*.suffix" (dirs or files) — the csproj
 *   scan precedent generalized (apple *.xcodeproj / *.xcworkspace, later
 *   haskell *.cabal, lua *.rockspec)
 * - all: every path must exist (file or dir) — unity's corroborating pair
 *   (ProjectVersion.txt must exist; Assets/ alone is not a Unity signal)
 */
type StackSignal = { stack: string; file: string } | { stack: string; glob: string } | { stack: string; all: string[] };

const STACK_SIGNALS: StackSignal[] = [
  { stack: "node", file: "package.json" },
  { stack: "node", file: "pnpm-workspace.yaml" },
  // Rush monorepos have no root package.json — rush.json is the root signal
  // (a Rush monorepo without it scores stacks: empty despite a full
  // apps/ + libraries/ tree, systematically under-scored).
  { stack: "node", file: "rush.json" },
  // HarmonyOS apps have no standard manifest in the list — oh-package.json5
  // is the ohpm manifest (hvigor + AppScope + entry/ structure; a HarmonyOS
  // repo without it scores stacks: empty despite the full layout). Detected
  // but transform-unsupported (cross-stack gates + notice), like
  // ruby/php/swift/dotnet.
  { stack: "harmonyos", file: "oh-package.json5" },
  { stack: "harmonyos", file: "build-profile.json5" },
  { stack: "python", file: "pyproject.toml" },
  { stack: "python", file: "requirements.txt" },
  { stack: "go", file: "go.mod" },
  { stack: "rust", file: "Cargo.toml" },
  { stack: "java", file: "pom.xml" },
  { stack: "java", file: "build.gradle" },
  { stack: "java", file: "build.gradle.kts" },
  { stack: "java", file: "settings.gradle" },
  { stack: "java", file: "settings.gradle.kts" },
  { stack: "ruby", file: "Gemfile" },
  { stack: "php", file: "composer.json" },
  { stack: "swift", file: "Package.swift" },
  // ---- A group (spec 0014, official-doc verified) --------------------------
  // apple: xcodeproj/workspace dirs (glob), Tuist Project.swift, CocoaPods
  // Podfile (apple, not ruby — CocoaPods docs place it beside .xcodeproj),
  // Carthage Cartfile (developer.apple.com / tuist.dev / guides.cocoapods.org
  // / Carthage Artifacts.md).
  { stack: "apple", glob: "*.xcodeproj" },
  { stack: "apple", glob: "*.xcworkspace" },
  { stack: "apple", file: "Project.swift" },
  { stack: "apple", file: "Podfile" },
  { stack: "apple", file: "Cartfile" },
  // c/cpp: cmake.org (CMakeLists.txt), mesonbuild.com ("meson.build at the
  // project root"), vcpkg manifest mode (vcpkg.json), conan (conanfile.txt at
  // root — conanfile.py intentionally not used: python-ambiguity).
  { stack: "c/cpp", file: "CMakeLists.txt" },
  { stack: "c/cpp", file: "meson.build" },
  { stack: "c/cpp", file: "vcpkg.json" },
  { stack: "c/cpp", file: "conanfile.txt" },
  // dart/flutter: pubspec.yaml is the shared root manifest (dart.dev package
  // layout — "that's what makes it a package"); the two cannot be separated
  // by static matching (merged stack).
  { stack: "dart/flutter", file: "pubspec.yaml" },
  // unity: ProjectVersion.txt (must) + Assets/ dir (corroborating) —
  // docs.unity3d.com lists both as the project's core structure; top-level
  // csproj is NOT a signal (generated artifact, usually gitignored).
  { stack: "unity", all: ["ProjectSettings/ProjectVersion.txt", "Assets"] },
  // zig: build.zig is the project's build script (ziglang.org build system).
  // The rest of the spec-0014 Tier-2 list (elixir/erlang/scala/clojure/
  // haskell/r/julia/lua/perl/bazel) is deferred until the skill has real
  // adoption — demand-driven.
  { stack: "zig", file: "build.zig" },
];

export interface ManifestHit {
  stack: string;
  file: string;
  exists: boolean;
}

export interface DetectResult {
  root: string;
  stacks: string[];
  manifests: ManifestHit[];
}

/** Top-level entries matching a "*.suffix" glob (dirs and files alike). */
function globHits(root: string, glob: string): string[] {
  // Only "*.suffix" patterns are supported — any other shape is a bug, fail loudly
  if (!glob.startsWith("*.") || glob.includes("/")) {
    throw new Error(`detect: unsupported glob pattern "${glob}" (only "*.suffix")`);
  }
  const suffix = glob.slice(1);
  return readdirSync(root).filter((f) => f.endsWith(suffix));
}

export function detect(root: string): DetectResult {
  const manifests: ManifestHit[] = [];
  for (const signal of STACK_SIGNALS) {
    if ("file" in signal) {
      manifests.push({ stack: signal.stack, file: signal.file, exists: existsSync(join(root, signal.file)) });
    } else if ("glob" in signal) {
      for (const f of globHits(root, signal.glob)) {
        manifests.push({ stack: signal.stack, file: f, exists: true });
      }
    } else {
      manifests.push({
        stack: signal.stack,
        file: signal.all[0],
        exists: signal.all.every((p) => existsSync(join(root, p))),
      });
    }
  }

  // *.csproj cannot be enumerated statically; scan the top-level directory
  const dotnetFiles = readdirSync(root).filter((f) => f.endsWith(".csproj"));
  if (dotnetFiles.length > 0) {
    manifests.push(...dotnetFiles.map((file) => ({ stack: "dotnet", file, exists: true })));
  }

  const stacks = [...new Set(manifests.filter((m) => m.exists).map((m) => m.stack))];
  return { root, stacks, manifests };
}

function parseRootArg(argv: string[]): string {
  const i = argv.indexOf("--root");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd();
}

// CLI entry: runs only when executed directly (importing from audit.ts
// must not trigger side effects)
if (isDirectEntry(import.meta.url)) {
  const root = parseRootArg(process.argv.slice(2));
  try {
    process.stdout.write(`${JSON.stringify(detect(root), null, 2)}\n`);
  } catch (err) {
    console.error(`detect: failed to scan ${root}: ${(err as Error).message}`);
    process.exit(1);
  }
}
