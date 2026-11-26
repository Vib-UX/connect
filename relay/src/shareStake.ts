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
  /** Lowest 24-hour change that can cover the stake. */
  fallbackSymbol: string | null;
  /** Token address of `fallbackSymbol`, when the book named one. */
  fallbackToken: string | null;
  credits: number;
}

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
 * The share to lock from a wallet of any size. Lowest 24-hour change that can
 * cover the stake. The same change breaks by token address.
 */
export function chooseShare(
  quotes: ShareQuote[],
  holdings: Array<string | ShareHolding>,
  usdStake?: number,
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
    const change = (left.quote.percentChange24h ?? 0) - (right.quote.percentChange24h ?? 0);
    if (change !== 0) return change;
    const leftKey = tieKey(left.holding);
    const rightKey = tieKey(right.holding);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });
  return ranked[0]?.holding ?? null;
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
  const chosen = chooseShare(quoted.quotes, book, usdStake);
  return {
    quotes: quoted.quotes,
    comparison,
    fallbackSymbol: chosen?.symbol ?? null,
    fallbackToken: chosen?.token ?? null,
    credits: quoted.credits + comparison.credits,
  };
}
