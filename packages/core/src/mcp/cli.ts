#!/usr/bin/env node
import { runConnectMcp } from "./server.js";
import type { HostKind } from "../types.js";

const host = (process.env.CONNECT_HOST ?? "cursor") as HostKind;
const displayName = process.env.CONNECT_DISPLAY_NAME;
const relayUrl = process.env.CONNECT_RELAY_URL;

runConnectMcp({ host, displayName, relayUrl }).catch((err) => {
  console.error(err);
  process.exit(1);
});
