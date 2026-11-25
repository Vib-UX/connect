#!/usr/bin/env node
/**
 * Cursor hook. Records the prompt on submit and the token cost when the turn stops.
 * Always allows the prompt. Never blocks the agent.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");

let event = {};
try {
  event = raw.trim() ? JSON.parse(raw) : {};
} catch {
  event = {};
}

const name = String(event.hook_event_name || process.argv[2] || "");
const dir = join(homedir(), ".connect");
const path = join(dir, "prompt-ledger.json");
mkdirSync(dir, { recursive: true });

let rows = [];
try {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(parsed)) rows = parsed;
} catch {
  rows = [];
}

const id = String(event.generation_id || "");
const model = String(event.model_id || event.model || "").replace(/^cursor-/, "");

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

if (name === "beforeSubmitPrompt") {
  const prompt = String(event.prompt || "").replace(/\s+/g, " ").trim();
  const row = {
    id,
    prompt,
    model,
    at: Date.now(),
    status: "pending",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const index = id ? rows.findIndex((item) => item.id === id) : -1;
  if (index >= 0) rows[index] = { ...rows[index], ...row, at: rows[index].at || row.at };
  else rows.unshift(row);
} else if (name === "stop") {
  const patch = {
    id,
    model,
    status: String(event.status || "completed"),
    input: num(event.input_tokens),
    output: num(event.output_tokens),
    cacheRead: num(event.cache_read_tokens),
    cacheWrite: num(event.cache_write_tokens),
    settledAt: Date.now(),
  };
  const index = id ? rows.findIndex((item) => item.id === id) : -1;
  if (index >= 0) {
    rows[index] = { ...rows[index], ...patch, model: patch.model || rows[index].model };
  } else {
    rows.unshift({ prompt: "", at: Date.now(), ...patch });
  }
}

writeFileSync(path, JSON.stringify(rows.slice(0, 40), null, 2));
if (name === "beforeSubmitPrompt") process.stdout.write('{"continue":true}\n');
process.exit(0);
