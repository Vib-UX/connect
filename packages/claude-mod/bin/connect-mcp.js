#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundled = join(here, "../vendor/mcp/server.js");
const workspace = join(here, "../../core/dist/mcp/server.js");
const file = existsSync(bundled) ? bundled : workspace;
if (!existsSync(file)) {
  console.error("Connect core is missing. Reinstall @hlvuser/connect.");
  process.exit(1);
}

const { runConnectMcp } = await import(pathToFileURL(file).href);
runConnectMcp({
  host: process.env.CONNECT_HOST ?? "claude",
  displayName: process.env.CONNECT_DISPLAY_NAME,
  relayUrl: process.env.CONNECT_RELAY_URL,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
