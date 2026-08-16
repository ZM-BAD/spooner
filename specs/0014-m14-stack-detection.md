---
status: shipped
target: M14
date: 2026-08-10
---

# M14: proactive stack detection — root-signal completeness (apple / c-cpp / dart-flutter / unity + zig; Tier-2 rest deferred)

## Background

The detection list must not lag ecosystem conventions: five same-class blind spots — Go `cmd/`+`pkg/` layout, Python flat top-level packages, WXT `entrypoints/`, Rush `rush.json`, HarmonyOS `oh-package.json5` — each surfaced only after a target repo scored `stacks: empty` or under-scored. Conclusion: **proactively complete the root-signal list** for mainstream ecosystems.

Design principles this spec pins (inherited, not new):

- **Detected but transform-unsupported is the honest tier** (decision #13, M6): new stacks get detect + audit credit + cross-stack gates + explicit notice, never a workflow — same as ruby/php/swift/dotnet/harmonyos. "Honest under-scoring beats systematic under-scoring."
- **Root signals require official-document evidence**: every manifest/layout/test convention is verified against official docs before landing — no knowledge-based claims.
- **No version chain**: detect/audit logic changes don't touch template bytes (rush.json `7dc8843` / harmonyos `49b34ab` precedents) — no TOOL_VERSION bump, no EXPECTED sync.
- **No tool-level probing** (decision #4 red line): only root manifests + layout/tool conventions, never per-tool config families.

## Goal (one sentence)

Mainstream ecosystems' root signals are proactively added to detect + audit (apple / c/cpp / dart-flutter / unity as Tier 1; zig from the Tier-2 batch — the rest deferred until real adoption), each official-doc-verified, detected-but-transform-unsupported, with regression tests and contract-doc revisions — closing the "detection lags ecology" meta-pattern.

## Scope

- **detect.ts `MANIFESTS` additions** (root-signal → stack rows, each verified against official docs — sources listed inline):

  | #   | Stack name     | Root signals (official-doc verified)                                                                                                  | Evidence                                                                                                                                                                                                                                                                                                                                             |
  | --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | A1  | `apple`        | `*.xcodeproj/project.pbxproj`（glob）, `*.xcworkspace`（glob）, `Project.swift` (Tuist), `Podfile` (CocoaPods), `Cartfile` (Carthage) | developer.apple.com archive (project.pbxproj / workspace); tuist.dev (Project.swift manifest); guides.cocoapods.org (Podfile at project root); Carthage Artifacts.md (Cartfile in working dir). **Podfile belongs to apple, not ruby** (ruby keeps Gemfile/gemspec only)                                                                             |
  | A2  | `c/cpp`        | `CMakeLists.txt`, `meson.build`, `vcpkg.json`, `conanfile.txt`                                                                        | cmake.org tutorial (CMakeLists.txt defines the project); mesonbuild.com ("all meson projects must have meson.build at the project root"); learn.microsoft.com vcpkg manifest mode (vcpkg.json name required); docs.conan.io ("conanfile at the root of your project")                                                                                |
  | A3  | `dart/flutter` | `pubspec.yaml`                                                                                                                        | dart.dev package-layout ("pubspec.yaml in the root directory… that's what makes it a package"); docs.flutter.dev ("every Flutter project includes a pubspec.yaml"). **Merged stack `dart/flutter` — Dart and Flutter share the file; static matching cannot distinguish them (owner decision: no content sniffing, the decision-#4 boundary holds)** |
  | A4  | `unity`        | `ProjectSettings/ProjectVersion.txt`（must）+ `Assets/`（dir, corroborating）                                                         | docs.unity3d.com (Assets folder + Project Settings folder + ProjectVersion.txt are the project's core structure). **Top-level csproj NOT used** (generated artifacts, undocumented, usually gitignored)                                                                                                                                              |
  | B1  | `zig`          | `build.zig`                                                                                                                           | ziglang.org build-system (project root build script). **The rest of the Tier-2 list (elixir/erlang/scala/clojure/haskell/r/julia/lua/perl/bazel) is DEFERRED** — official-doc verified but held until the skill has real adoption — demand-driven                                                                                                    |

  **New detect.ts capabilities required**: glob-style top-level scans for `*.xcodeproj` / `*.xcworkspace` (the csproj scan precedent generalizes; the deferred Tier-2 batch would add `*.cabal` / `*.rockspec`), directory checks for `Assets/`, and a corroborating-pair rule for unity (ProjectVersion.txt must exist).

- **audit integration** (same slice, no new checks):
  - `SUBSTACK_MANIFESTS` mirrors the new detect rows — **exact-match representatives only** (apple → `Podfile`, c/cpp → `CMakeLists.txt`, dart/flutter → `pubspec.yaml`, unity → `ProjectSettings/ProjectVersion.txt`, zig → `build.zig`); glob signals (`*.xcodeproj`) do not participate in the bounded sub-stack scan (review R3)
  - `stackCommandSources` / `stackLintCommandOf`: apple → `xcodebuild test` (build+test), c/cpp → `cmake --build` + `ctest` (build+test), dart/flutter → `flutter test` (test-only band), unity → no lifecycle command (documented ceiling). **Evidence strings reference the actually-present signal file** (the python `existsSync ? pyproject.toml : requirements.txt` precedent — never hard-code a manifest that may not exist; review R4). **Branch order: appended after the php branch, before the fallback null** — order is the implicit priority; secondary-stack signals fill gaps without hijacking the primary stack (the php `phpSource` pattern; review R5)
  - **C group (layout, struct-layout)**: Flutter `lib/` is already covered by the generic root-level `["src", "lib", "packages"]` list — test only, no code change; C/C++ gains `include/` as an additional recognized dir (with `src/`); Apple has no strong layout convention → documented ceiling, not recognized
  - **D group (tests + tools) — two lists, explicitly**: (a) the CI tool-name regex (`\b(prettier|black|gofmt|rustfmt|dprint|ruff)\b`, audit.ts) gains `swiftformat` / `clang-format` / `cmake-format`; (b) the formatter config-file list (the biome.json / ruff.toml area) gains `.clang-format` / `.swiftformat` (review R6). Test-file scan: `test/` is already walked (findTestFiles scans test/tests/spec) — verify with fixtures; XCTest conventions (apple) and `gtest`/`catch2`/`CTest` (c/cpp) follow the existing test-dir + name patterns
- **Regression tests** per stack: fixture writes the root signal + `detect(...).stacks` assertion (existing pattern); audit scoring tests where a new signal changes a score.
- **Contract-doc in-place revisions**: spec 0001 stack matrix, spec 0013 check definitions, SKILL.md stack list/notes, AGENTS.md status, README matrix (bilingual) — current-state only.
- **No TOOL_VERSION bump** (no template bytes).

## Non-goals

- Deep transform for any new stack (no workflows, no pre-commit gates, no lifecycle-verified CI — detect+audit only, the M6 contract for unsupported stacks)
- Per-tool config detection (decision #4 red line) — e.g. no `.clang-format` probing as a stack signal
- Semantic assessment (zero-LLM red line)
- Changing existing stacks' behavior (priority order, mixed-repo rules, existing signals)

## Acceptance criteria (all must pass for shipped)

1. **Detection**: each Tier-1 stack fixture (root signal file written) → `detect(root).stacks` includes the stack name; negative fixtures (no signal) stay empty
2. **Doc evidence**: every root signal lands with an official-doc source recorded (spec background table or code comment) — no knowledge-based entries
3. **Priority**: existing order unchanged — mixed fixtures (e.g. node + pubspec.yaml, go + CMakeLists.txt) still resolve the existing primary stack
4. **Audit credit**: a new-stack fixture with the stack's lifecycle command in AGENTS.md → `agents-commands` credits it (traceable), without changing other stacks' scores
5. **Layout/tools**: C-group fixtures (Flutter `lib/`, C/C++ `include/`+`src/`) score struct-layout; D-group tool names (swiftformat/clang-format/cmake-format) credit cfg-format/lint where the check's whitelist applies
6. **Unsupported notice**: transform on a new-stack fixture → cross-stack gates only + "transform not supported yet" notice naming the supported list
7. **Sub-stack scan**: bounded one-level scan recognizes new manifests in direct child dirs; vendored dirs still excluded
8. **Regression**: typecheck + markdownlint + full suite green (suite count at ship time — no static test counts in contract docs); determinism double-run diff empty
9. **Docs**: SKILL.md / README (bilingual) / AGENTS.md / specs 0001+0013 updated current-state
10. **Mixed-repo behavior pinned** (review R2, corrected at implementation): (a) RN-like repo (package.json + `ios/*.xcodeproj` + `android/build.gradle` — signals in subdirs) stays **node-only** — detect scans the root only, no inflation; (b) iOS-app-with-node-tooling repo (top-level `*.xcodeproj` + package.json) → stacks node+apple, `primaryStack` still resolves to node, agents-commands/build scores unchanged from the pre-M14 node-only behavior

## Slice plan

| Slice | Content                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------- |
| 1     | Tier-1 detection (apple/c-cpp/dart-flutter/unity): doc-verified root signals + detect rows + regression tests |
| 2     | audit integration for Tier 1: SUBSTACK_MANIFESTS + stackCommandSources + C-group layout + D-group tests/tools |
| 3     | Tier-2: zig (build.zig) detect + audit credit — the rest of the batch deferred until real adoption            |
| 4     | Contract docs (spec 0001/0013, SKILL.md, README ×2, AGENTS.md) + full verification                            |

## Risks

- **Detection inflation changes existing repos' reports (expected, but must be pinned)**: React Native repos do NOT inflate — their `ios/*.xcodeproj` / `android/build.gradle` live in subdirs and detect scans the root only (the existing "detect only scans the repo root" boundary). Inflation only hits top-level mixed repos (e.g. an iOS app with a node toolchain: `*.xcodeproj` + package.json → node+apple), and Flutter-with-package.json repos (node+dart/flutter) — honest detection, but a user-visible behavior change; fixtures pin that the primary stack (`STACK_PRIORITY` stays `[node, python, go, java, rust]`) and scores do not regress (acceptance 10)
- **Root-signal ambiguity**: `Podfile` could signal ruby (a ruby tool chain) — doc verification pinned the apple interpretation (Podfile-only repo = iOS app); generic names (`DESCRIPTION`, `Project.toml`) stay exact-match, no content sniffing — the deferred Tier-2 batch re-evaluates them on adoption
- **Score inflation without honesty**: new detection may lift scores (e.g. a C++ repo newly credited 2/2 commands) — the check definitions and evidence strings stay deterministic and traceable; determinism double-run is the guard
- **Notice noise**: every new stack adds an "unsupported" branch to transform's notice — the notice stays one line naming supported stacks (no per-stack noise)
- **Scope creep into deep support**: Tier-1 stacks will attract "can we transform?" — non-goals pin detect+audit only until demand-driven (M11 precedent)
