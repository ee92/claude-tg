// Resolve the correct Claude Code native binary for the current platform.
//
// Why this exists: @anthropic-ai/claude-agent-sdk ships eight platform-specific
// optional deps (linux/macOS/windows × x64/arm64, plus glibc/musl variants on
// linux). When `npm install` lands more than one of them on disk — which can
// happen via stray cross-platform installs, `--force`, or an inherited lockfile
// — the SDK's runtime picker prefers the musl variant first and never falls
// through, even on glibc systems. That fails with:
//   "Claude Code native binary not found at .../claude-agent-sdk-linux-x64-musl/claude"
// (the binary IS on disk; it just won't run on a glibc machine).
//
// Open upstream issue, no Anthropic-shipped fix yet:
//   https://github.com/anthropics/claude-agent-sdk-typescript/issues/296
//
// Workaround documented in that issue: pass `pathToClaudeCodeExecutable` to
// query() with the path to the correct variant. We do that detection here, by
// resolving the variant package by NAME via Node's normal package resolver —
// no hardcoded filesystem paths, portable across machines and platforms.

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// Node populates `glibcVersionRuntime` only on glibc systems; absent on musl.
// Standard idiom used by node-pre-gyp and friends. Memoised because
// `process.report.getReport()` is non-trivial work and we'd otherwise call
// it twice during module init (resolve + log).
let _libc: "glibc" | "musl" | undefined;
function detectLibc(): "glibc" | "musl" {
  if (_libc !== undefined) return _libc;
  try {
    const report = process.report.getReport() as unknown as {
      header?: { glibcVersionRuntime?: string };
    };
    _libc = report.header?.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    _libc = "glibc"; // safe default: most servers are glibc
  }
  return _libc;
}

function variantPackageName(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux") {
    const suffix = detectLibc() === "musl" ? "-musl" : "";
    return `@anthropic-ai/claude-agent-sdk-linux-${arch}${suffix}`;
  }
  if (platform === "darwin") return `@anthropic-ai/claude-agent-sdk-darwin-${arch}`;
  if (platform === "win32") return `@anthropic-ai/claude-agent-sdk-win32-${arch}`;
  throw new Error(`Unsupported platform for Claude Agent SDK: ${platform}-${arch}`);
}

function resolve(): string {
  const pkg = variantPackageName();
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve(`${pkg}/package.json`);
  } catch (e) {
    throw new Error(
      `Claude Agent SDK binary not resolvable: variant package "${pkg}" is not ` +
      `installed for ${process.platform}-${process.arch} (${detectLibc()}). ` +
      `Run \`npm install\` to ensure the optional dependency is present. ` +
      `Underlying: ${(e as Error).message}`,
    );
  }
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  return path.join(path.dirname(pkgJsonPath), binaryName);
}

// Computed once at module load so the choice gets logged on startup.
export const claudeBinaryPath: string = resolve();
console.log(
  `sdk: claude binary → ${claudeBinaryPath} ` +
  `(platform=${process.platform}-${process.arch} libc=${detectLibc()})`,
);
