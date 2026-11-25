#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.CONNECT_CORE_CLI,
  join(here, "../../core/dist/mcp/cli.js"),
  "/Users/btc/connect/packages/core/dist/mcp/cli.js",
].filter(Boolean);

const cli = candidates.find((p) => existsSync(p));
if (!cli) {
  console.error(
    "Connect MCP: built core CLI not found. Run: pnpm --filter @connect/core build",
  );
  process.exit(1);
}

process.env.CONNECT_HOST = process.env.CONNECT_HOST ?? "cursor";
await import(pathToFileURL(cli).href);
