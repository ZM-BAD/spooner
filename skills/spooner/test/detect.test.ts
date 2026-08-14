import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detect } from "../scripts/detect.ts";

/** Fresh fixture repo (not a git repo). */
function fixture(): string {
  return mkdtempSync(join(tmpdir(), "spooner-detect-"));
}

function stacksOf(repo: string): string[] {
  return detect(repo).stacks;
}

// --- spec 0014 slice 1: A-group root signals (official-doc verified) ---

test("apple: *.xcodeproj dir detected", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "MyApp.xcodeproj"));
  assert.ok(stacksOf(repo).includes("apple"));
});

test("apple: *.xcworkspace dir detected", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "MyApp.xcworkspace"));
  assert.ok(stacksOf(repo).includes("apple"));
});

test("apple: Tuist Project.swift detected", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "Project.swift"), "import ProjectDescription\n");
  assert.ok(stacksOf(repo).includes("apple"));
});

test("apple: CocoaPods Podfile detected as apple, not ruby", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "Podfile"), "platform :ios, '15.0'\n");
  const stacks = stacksOf(repo);
  assert.ok(stacks.includes("apple"));
  assert.ok(!stacks.includes("ruby"));
});

test("apple: Carthage Cartfile detected", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "Cartfile"), 'github "Alamofire/Alamofire"\n');
  assert.ok(stacksOf(repo).includes("apple"));
});

test("c/cpp: CMakeLists.txt detected", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.16)\n");
  assert.ok(stacksOf(repo).includes("c/cpp"));
});

test("c/cpp: meson.build detected", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "meson.build"), "project('demo', 'c')\n");
  assert.ok(stacksOf(repo).includes("c/cpp"));
});

test("c/cpp: vcpkg.json detected", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "vcpkg.json"), '{"name": "demo"}\n');
  assert.ok(stacksOf(repo).includes("c/cpp"));
});

test("c/cpp: conanfile.txt detected", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "conanfile.txt"), "[requires]\n");
  assert.ok(stacksOf(repo).includes("c/cpp"));
});

test("dart/flutter: pubspec.yaml detected as the merged stack", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "pubspec.yaml"), "name: demo\n");
  assert.ok(stacksOf(repo).includes("dart/flutter"));
});

test("unity: ProjectVersion.txt + Assets/ detected (corroborating pair)", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "Assets"), { recursive: true });
  mkdirSync(join(repo, "ProjectSettings"), { recursive: true });
  writeFileSync(join(repo, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2022.3.20f1\n");
  assert.ok(stacksOf(repo).includes("unity"));
});

test("unity: ProjectVersion.txt alone is NOT unity (Assets must corroborate)", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "ProjectSettings"), { recursive: true });
  writeFileSync(join(repo, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2022.3.20f1\n");
  assert.ok(!stacksOf(repo).includes("unity"));
});

test("unity: Assets/ alone is NOT unity (ProjectVersion.txt must exist)", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "Assets"), { recursive: true });
  assert.ok(!stacksOf(repo).includes("unity"));
});

test("empty repo: no A-group stacks", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.deepEqual(stacksOf(repo), []);
});

// --- mixed repos (acceptance 10): root-scan boundary + no primary regression ---

test("mixed: go.mod + CMakeLists.txt → go + c/cpp (existing stack untouched)", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "go.mod"), "module demo\n");
  writeFileSync(join(repo, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.16)\n");
  const stacks = stacksOf(repo);
  assert.ok(stacks.includes("go"));
  assert.ok(stacks.includes("c/cpp"));
});

test("mixed: RN-like repo — subdir signals do NOT inflate (root scan only)", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "package.json"), '{"name": "app"}\n');
  mkdirSync(join(repo, "ios", "App.xcodeproj"), { recursive: true });
  mkdirSync(join(repo, "android"), { recursive: true });
  writeFileSync(join(repo, "android", "build.gradle"), "// android\n");
  assert.deepEqual(stacksOf(repo), ["node"]);
});

test("mixed: iOS app with node tooling (top-level xcodeproj + package.json) → node+apple", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "package.json"), '{"name": "app"}\n');
  mkdirSync(join(repo, "MyApp.xcodeproj"));
  const stacks = stacksOf(repo);
  assert.ok(stacks.includes("node"));
  assert.ok(stacks.includes("apple"));
});

test("mixed: pubspec.yaml + package.json → node + dart/flutter", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "package.json"), '{"name": "tool"}\n');
  writeFileSync(join(repo, "pubspec.yaml"), "name: app\n");
  const stacks = stacksOf(repo);
  assert.ok(stacks.includes("node"));
  assert.ok(stacks.includes("dart/flutter"));
});

// --- spec 0014 slice 3: B-group root signals (official-doc verified) --------

test("zig: build.zig detected", (t) => {
  const repo = fixture();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "build.zig"), "pub fn build(b: *std.Build) void {}\n");
  assert.ok(stacksOf(repo).includes("zig"));
});
