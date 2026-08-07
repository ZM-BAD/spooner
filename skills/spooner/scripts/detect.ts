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

/** Known manifests mapped to their stacks */
const MANIFESTS = [
  ["node", "package.json"],
  ["node", "pnpm-workspace.yaml"],
  ["python", "pyproject.toml"],
  ["python", "requirements.txt"],
  ["go", "go.mod"],
  ["rust", "Cargo.toml"],
  ["java", "pom.xml"],
  ["java", "build.gradle"],
  ["java", "build.gradle.kts"],
  ["java", "settings.gradle"],
  ["java", "settings.gradle.kts"],
  ["ruby", "Gemfile"],
  ["php", "composer.json"],
  ["swift", "Package.swift"],
] as const;

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

export function detect(root: string): DetectResult {
  const manifests: ManifestHit[] = MANIFESTS.map(([stack, file]) => ({
    stack,
    file,
    exists: existsSync(join(root, file)),
  }));

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
