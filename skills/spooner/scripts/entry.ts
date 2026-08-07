/**
 * Shared CLI entry guard (used by all six scripts).
 *
 * Runs the script's main() only when the script is executed directly —
 * importing must not trigger side effects (tests import run() from these
 * modules). Compares REAL paths on both sides: the module loader resolves
 * symlinks in import.meta.url, but process.argv[1] keeps the path as typed —
 * a strict string equality silently skipped main() for any invocation through
 * a symlinked directory or file (exit 0, no output; found 2026-08-07).
 *
 * Zero dependencies (Node builtins only).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isDirectEntry(moduleUrl: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
