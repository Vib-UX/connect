import { compareWithFearAndGreed, quoteShares, type MarketComparison, type ShareQuote } from "./coinmarketcap.js";

/** One share sitting in a wallet. A wallet can hold many of these. */
export interface ShareHolding {
  symbol: string;
  /** Token address. Equal 24-hour changes break by this address. */
  token?: string;
  /** Free balance in token base units. Omitted means the balance was not checked. */
  balance?: bigint;
  decimals?: number;
}

export interface ShareStakeReading {
  quotes: ShareQuote[];
  comparison: MarketComparison;
  /** Share chosen for this book after Cournot and Fear and Greed. */
  fallbackSymbol: string | null;
  /** Token address of `fallbackSymbol`, when the book named one. */
  fallbackToken: string | null;
  credits: number;
}

export type SharePrefer = "worst" | "best";

function asHolding(entry: string | ShareHolding): ShareHolding {
  return typeof entry === "string" ? { symbol: entry } : entry;
}

function quoteFor(quotes: ShareQuote[], symbol: string): ShareQuote | undefined {
  const key = symbol.trim().toUpperCase();
  return quotes.find((quote) => quote.symbol.toUpperCase() === key);
}

/** True when the free balance is worth at least `usdStake` dollars at the quoted price. */
export function coversStake(holding: ShareHolding, quote: ShareQuote, usdStake: number | undefined): boolean {
  if (usdStake === undefined || holding.balance === undefined) return true;
  if (quote.priceUsd == null || quote.priceUsd <= 0 || usdStake < 0) return false;
  const decimals = holding.decimals ?? 18;
  const priceE8 = BigInt(Math.round(quote.priceUsd * 1e8));
  const stakeE8 = BigInt(Math.round(usdStake * 1e8));
  if (priceE8 <= 0n) return false;
  const scale = 10n ** BigInt(decimals);
  return holding.balance * priceE8 >= stakeE8 * scale;
}

function tieKey(holding: ShareHolding): string {
  return (holding.token ?? holding.symbol).trim().toLowerCase();
}

/**
 * The share to lock from a wallet of any size.
 * `worst` is the lowest 24-hour change that covers the stake.
 * `best` is the highest. The same change breaks by token address.
 */
export function chooseShare(
  quotes: ShareQuote[],
  holdings: Array<string | ShareHolding>,
  usdStake?: number,
  prefer: SharePrefer = "worst",
): ShareHolding | null {
  const ranked = holdings
    .map(asHolding)
    .map((holding) => {
      const quote = quoteFor(quotes, holding.symbol);
      return { holding, quote };
    })
    .filter((row): row is { holding: ShareHolding; quote: ShareQuote } => {
      if (!row.quote || typeof row.quote.percentChange24h !== "number") return false;
      return coversStake(row.holding, row.quote, usdStake);
    });
  ranked.sort((left, right) => {
    const leftChange = left.quote.percentChange24h ?? 0;
    const rightChange = right.quote.percentChange24h ?? 0;
    const change = prefer === "worst" ? leftChange - rightChange : rightChange - leftChange;
    if (change !== 0) return change;
    const leftKey = tieKey(left.holding);
    const rightKey = tieKey(right.holding);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });
  return ranked[0]?.holding ?? null;
}

/** Unique covering symbols across the wallets. Cournot is called on this set. */
export function coveringSymbols(
  quotes: ShareQuote[],
  holdingsLists: Array<Array<string | ShareHolding>>,
  usdStake?: number,
): string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const holdings of holdingsLists) {
    for (const entry of holdings) {
      const holding = asHolding(entry);
      const key = holding.symbol.trim().toUpperCase();
      if (!key || seen.has(key)) continue;
      const quote = quoteFor(quotes, holding.symbol);
      if (!quote || typeof quote.percentChange24h !== "number") continue;
      if (!coversStake(holding, quote, usdStake)) continue;
      seen.add(key);
      symbols.push(holding.symbol);
    }
  }
  return symbols;
}

/** Prefer the worst share when Cournot and Fear and Greed lean the same way. */
export function preferFromAgreement(agrees: boolean): SharePrefer {
  return agrees ? "worst" : "best";
}

/**
 * Token each player locks. The same Cournot and Fear and Greed comparison
 * ranks both books. A player with no covering share locks USDT.
 */
export function lockTokensForPlayers(
  quotes: ShareQuote[],
  holdingsA: Array<string | ShareHolding>,
  holdingsB: Array<string | ShareHolding>,
  usdStake: number,
  agrees: boolean,
  usdt: string,
): { tokenA: string; tokenB: string; symbolA: string | null; symbolB: string | null } {
  const prefer = preferFromAgreement(agrees);
  const chosenA = chooseShare(quotes, holdingsA, usdStake, prefer);
  const chosenB = chooseShare(quotes, holdingsB, usdStake, prefer);
  return {
    tokenA: chosenA?.token ?? usdt,
    tokenB: chosenB?.token ?? usdt,
    symbolA: chosenA?.symbol ?? null,
    symbolB: chosenB?.symbol ?? null,
  };
}

/** Quote the whole book and compare Cournot's down probability with CMC Fear and Greed. */
export async function readShareStake(
  holdings: Array<string | ShareHolding>,
  cournotProbability: number,
  deps: {
    quote?: typeof quoteShares;
    compare?: typeof compareWithFearAndGreed;
  } = {},
  usdStake?: number,
): Promise<ShareStakeReading> {
  const book = holdings.map(asHolding);
  const quote = deps.quote ?? quoteShares;
  const compare = deps.compare ?? compareWithFearAndGreed;
  const [quoted, comparison] = await Promise.all([
    quote(book.map((holding) => holding.symbol)),
    compare(cournotProbability),
  ]);
  const chosen = chooseShare(quoted.quotes, book, usdStake, preferFromAgreement(comparison.agrees));
  return {
    quotes: quoted.quotes,
    comparison,
    fallbackSymbol: chosen?.symbol ?? null,
    fallbackToken: chosen?.token ?? null,
    credits: quoted.credits + comparison.credits,
  };
}
