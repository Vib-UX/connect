import { compareWithFearAndGreed, quoteShares, type MarketComparison, type ShareQuote } from "./coinmarketcap.js";

export interface ShareStakeReading {
  quotes: ShareQuote[];
  comparison: MarketComparison;
  /** Lowest 24-hour change. Used when every Cournot call abstains. */
  fallbackSymbol: string | null;
  credits: number;
}

/** Quote the book and compare Cournot's down probability with CMC Fear and Greed. */
export async function readShareStake(
  symbols: string[],
  cournotProbability: number,
  deps: {
    quote?: typeof quoteShares;
    compare?: typeof compareWithFearAndGreed;
  } = {},
): Promise<ShareStakeReading> {
  const quote = deps.quote ?? quoteShares;
  const compare = deps.compare ?? compareWithFearAndGreed;
  const [quoted, comparison] = await Promise.all([quote(symbols), compare(cournotProbability)]);
  const ranked = quoted.quotes.filter((quote) => typeof quote.percentChange24h === "number");
  ranked.sort((left, right) => (left.percentChange24h ?? 0) - (right.percentChange24h ?? 0));
  return {
    quotes: quoted.quotes,
    comparison,
    fallbackSymbol: ranked[0]?.symbol ?? null,
    credits: quoted.credits + comparison.credits,
  };
}
