#!/usr/bin/env node
import("../dist/cli/main.js").catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
