/**
 * Stack lifecycle commands — the single source of truth for canonical
 * per-stack commands (spec 0015 slice 2). The audit's command-source
 * existence checks and the transform's generated AGENTS.md command table
 * both consume this definition, so coverage and command text can never drift
 * between the score evidence and the generated artifact (pitfall class 3:
 * audit credit vs artifact contradiction; the stack-parity test enforces
 * coverage).
 *
 * Stacks with dynamic lifecycle resolution (node package.json scripts,
 * java gradle/maven, php phpunit presence) stay in their consumers — only
 * canonical, static lifecycles live here. Adding a detect stack must reach
 * this table or name a documented ceiling.
 */

export interface CanonicalCommand {
  command: string;
  purpose: string;
}

/** Go test command excludes e2e suites (plain `go test ./...` sweeps
 *  Ginkgo e2e cases into the local gate). */
export const GO_TEST_COMMAND = "go test $(go list ./... | grep -v /test/e2e)";

export const STACK_COMMANDS: Record<string, CanonicalCommand[]> = {
  go: [
    { command: "go build ./...", purpose: "build" },
    { command: GO_TEST_COMMAND, purpose: "test" },
    { command: "go vet ./...", purpose: "vet" },
  ],
  rust: [
    { command: "cargo build", purpose: "build" },
    { command: "cargo test", purpose: "test" },
    { command: "cargo fmt --check", purpose: "format check" },
    { command: "cargo clippy", purpose: "lint" },
  ],
  python: [{ command: "python3 -m unittest discover", purpose: "test" }],
  "c/cpp": [
    { command: "cmake --build", purpose: "build" },
    { command: "ctest", purpose: "test" },
  ],
  zig: [
    { command: "zig build", purpose: "build" },
    { command: "zig build test", purpose: "test" },
  ],
  apple: [
    { command: "xcodebuild build", purpose: "build" },
    { command: "xcodebuild test", purpose: "test" },
  ],
  "dart/flutter": [
    { command: "flutter test", purpose: "test" },
    { command: "dart analyze", purpose: "lint" },
  ],
};

/** Canonical lifecycle existence for the audit's command-source check —
 *  `vet` counts as lint (go's historical purpose text, pinned). */
export function lifecycleOf(stack: string): { build: boolean; test: boolean; lint: boolean } {
  const cs = STACK_COMMANDS[stack] ?? [];
  return {
    build: cs.some((c) => c.purpose === "build"),
    test: cs.some((c) => c.purpose === "test"),
    lint: cs.some((c) => c.purpose === "lint" || c.purpose === "vet"),
  };
}

/** Stacks whose canonical lifecycle is dynamic (declared scripts / build
 *  tool presence) — resolved by the consumers, not this table. */
export const DYNAMIC_LIFECYCLE_STACKS: readonly string[] = ["node", "java", "php"];
