#!/usr/bin/env bun
// ─── Relay server CLI entrypoint ────────────────────────────────────────
import { RelayServer } from "./server";
import * as fs from "node:fs";

const argv = process.argv.slice(2);
const quiet = argv.includes("--quiet");
// Socket path is the first positional (non-flag) argument; falls back to
// the well-known default. Filtering flags prevents bugs like
// `bun shared/relay/main.ts --quiet` binding to a file literally named
// `--quiet` in the cwd.
const socketPath =
  argv.find((a) => !a.startsWith("--")) || "/tmp/agent-channels.sock";
const httpPort = parseInt(process.env.RELAY_HTTP_PORT || "7700", 10);
const httpHost = process.env.RELAY_HTTP_HOST || "0.0.0.0";

// Clean up stale socket
try {
  fs.unlinkSync(socketPath);
} catch {
  /* doesn't exist */
}

const server = new RelayServer({
  socketPath,
  httpPort,
  httpHost,
  verbose: !quiet,
});
server.start();

console.log(`[relay] UDS listening on ${socketPath}`);
console.log(`[relay] HTTP listening on http://${httpHost}:${httpPort}`);
console.log(`[relay] logging: ${quiet ? "quiet" : "verbose"}`);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[relay] shutting down");
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
