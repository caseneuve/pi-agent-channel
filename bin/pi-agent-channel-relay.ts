#!/usr/bin/env bun

const relayManager = new URL("../scripts/relay-manager.ts", import.meta.url)
  .pathname;
const child = Bun.spawnSync(["bun", relayManager, ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(child.exitCode);
