// `start` subcommand: lazy-import the daemon and run it. Lazy is important —
// importing the daemon evaluates ../config.ts at module-load time, which
// fails (with a helpful pointer at `init`) if the user hasn't configured
// anything. We don't want that to fire for `init`, `status`, or `uninstall`.

export async function runStart(): Promise<void> {
  await import("../daemon.js");
}
