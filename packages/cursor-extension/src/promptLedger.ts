import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PromptRecord {
  id?: string;
  prompt?: string;
  model?: string;
  at?: number;
  settledAt?: number;
  status?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PromptLine {
  title: string;
  meta: string;
  amount: string;
  at: number;
}

export function connectDir(): string {
  return join(homedir(), ".connect");
}

export function promptLedgerPath(): string {
  return join(connectDir(), "prompt-ledger.json");
}

/** USD per million tokens. Grok matches the observed Cursor estimate of $2 in / $6 out. */
function rates(model: string): { input: number; output: number } {
  const id = model.toLowerCase();
  if (id.includes("grok")) return { input: 2, output: 6 };
  if (id.includes("haiku") || id.includes("flash") || id.includes("mini")) return { input: 1, output: 5 };
  if (id.includes("opus") || id.includes("fable")) return { input: 15, output: 75 };
  return { input: 3, output: 15 };
}

export function promptCostUsd(row: PromptRecord): number {
  const model = row.model || "";
  const price = rates(model);
  const input = Math.max(0, Number(row.input) || 0);
  const output = Math.max(0, Number(row.output) || 0);
  const cacheRead = Math.max(0, Number(row.cacheRead) || 0);
  const cacheWrite = Math.max(0, Number(row.cacheWrite) || 0);
  const fresh = Math.max(0, input - cacheRead - cacheWrite);
  return (
    (fresh * price.input + cacheRead * price.input * 0.1 + cacheWrite * price.input * 1.25 + output * price.output) /
    1_000_000
  );
}

function money(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function commas(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function clock(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function titleOf(prompt: string): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!text) return "(empty prompt)";
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

export function promptLines(rows: PromptRecord[]): PromptLine[] {
  return rows.slice(0, 24).map((row) => {
    const when = clock(row.settledAt || row.at || Date.now());
    const model = (row.model || "model").replace(/^cursor-/, "");
    const pending = row.status === "pending" || ((row.input || 0) === 0 && (row.output || 0) === 0);
    if (pending) {
      return {
        title: titleOf(row.prompt || ""),
        meta: `${model} · running · ${when}`,
        amount: "…",
        at: row.at || Date.now(),
      };
    }
    return {
      title: titleOf(row.prompt || ""),
      meta: `${model} · ${commas(row.input || 0)} in / ${commas(row.output || 0)} out · est · ${when}`,
      amount: money(promptCostUsd(row)),
      at: row.at || row.settledAt || Date.now(),
    };
  });
}

export function readPromptRecords(): PromptRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(promptLedgerPath(), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as PromptRecord[]) : [];
  } catch {
    return [];
  }
}

export class PromptLedger {
  private timer: ReturnType<typeof setTimeout> | undefined;

  watch(onChange: () => void): { dispose: () => void } {
    mkdirSync(connectDir(), { recursive: true });
    if (!existsSync(promptLedgerPath())) writeFileSync(promptLedgerPath(), "[]\n");
    const watcher = watch(connectDir(), () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(onChange, 150);
    });
    return {
      dispose: () => {
        clearTimeout(this.timer);
        watcher.close();
      },
    };
  }

  lines(): PromptLine[] {
    return promptLines(readPromptRecords());
  }
}
