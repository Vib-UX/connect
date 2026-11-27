import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/cursor-plugin/skills/cournot/scripts/cournot-client.mjs",
);

const CLAIM_NAME: Record<string, string> = {
  NVDA: "NVIDIA",
  GOLD: "gold",
  TSLA: "Tesla",
};

export type CournotCommand = "resolve" | "prepare";
export type CournotRunner = (command: CournotCommand, body: unknown) => Promise<unknown>;

interface CournotMarket {
  matching_confidence?: number;
  market_info?: { id?: string | number };
}

/** Forward claim Cournot scores for a held share. */
export function downClaim(symbol: string): string {
  const key = symbol.trim().toUpperCase();
  const name = CLAIM_NAME[key] ?? key;
  return `${name} price finishes down over the next 24 hours`;
}

function uniqueSymbols(symbols: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of symbols) {
    const symbol = raw.trim();
    if (!symbol) continue;
    const key = symbol.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(symbol);
  }
  return out;
}

function marketsFrom(result: unknown): CournotMarket[] {
  const root = result as {
    response?: { data?: { markets?: CournotMarket[] } };
    data?: { markets?: CournotMarket[] };
  };
  return root.response?.data?.markets ?? root.data?.markets ?? [];
}

/** One market, or a clear leader. Otherwise Cournot abstains on that share. */
export function pickMarketId(markets: CournotMarket[]): string | null {
  const ranked = markets
    .map((market) => ({
      id: String(market.market_info?.id ?? "").trim(),
      confidence: market.matching_confidence ?? 0,
    }))
    .filter((market) => market.id);
  if (ranked.length === 0) return null;
  ranked.sort((left, right) => right.confidence - left.confidence);
  if (ranked.length === 1) return ranked[0].id;
  if (ranked[0].confidence >= 0.85 && ranked[0].confidence - ranked[1].confidence >= 0.15) {
    return ranked[0].id;
  }
  return null;
}

function probabilityFrom(result: unknown): number | null {
  const root = result as {
    state?: string;
    response?: { data?: { probability?: number; result?: { point_estimate?: number } } };
    data?: { probability?: number; result?: { point_estimate?: number } };
  };
  if (root.state && root.state !== "complete") return null;
  const data = root.response?.data ?? root.data;
  const value = data?.probability ?? data?.result?.point_estimate;
  return typeof value === "number" ? value : null;
}

function defaultRunner(command: CournotCommand, body: unknown): Promise<unknown> {
  const request = Buffer.from(JSON.stringify(body)).toString("base64");
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLIENT, command, "--request-base64", request], {
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || "Cournot did not return a probability."));
        return;
      }
      try {
        resolveResult(JSON.parse(out) as unknown);
      } catch {
        reject(new Error("Cournot did not return a probability."));
      }
    });
  });
}

async function downProbabilityForSymbol(
  symbol: string,
  run: CournotRunner,
): Promise<number | null> {
  const message = downClaim(symbol);
  const resolved = await run("resolve", { message, limit: 5 });
  const marketId = pickMarketId(marketsFrom(resolved));
  if (!marketId) return null;
  const prepared = await run("prepare", { message, market_ids: [marketId] });
  const probability = probabilityFrom(prepared);
  if (probability == null || probability < 0 || probability > 1) return null;
  return probability;
}

/**
 * Cournot down-probability for the shares actually held.
 * One resolve + probability call per unique symbol. The book lean is the mean.
 */
export async function cournotDownProbability(
  symbols: string[],
  run: CournotRunner = defaultRunner,
): Promise<number> {
  const held = uniqueSymbols(symbols);
  if (held.length === 0) {
    throw new Error("Cournot needs a held share.");
  }
  const readings = await Promise.all(held.map((symbol) => downProbabilityForSymbol(symbol, run)));
  const usable = readings.filter((value): value is number => value != null);
  if (usable.length === 0) {
    throw new Error("Cournot did not match a market for the held shares.");
  }
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}
