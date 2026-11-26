import assert from "node:assert/strict";
import test from "node:test";
import type { MarketComparison, ShareQuote } from "./coinmarketcap.js";
import { chooseShare, readShareStake, type ShareHolding } from "./shareStake.js";

test("the fallback share is the worst 24-hour change, beside the Cournot comparison", async () => {
  const quotes: ShareQuote[] = [
    { symbol: "NVDA", name: "Nvidia Corp", priceUsd: 150, percentChange24h: 1.7 },
    { symbol: "TSLA", name: "Tesla, Inc.", priceUsd: 382, percentChange24h: -0.4 },
    { symbol: "GOLD", name: "Gold", priceUsd: 3558, percentChange24h: 1.4 },
  ];
  const comparison: MarketComparison = {
    cournotProbability: 0.625,
    fearGreed: 10,
    classification: "Extreme fear",
    updatedAt: "2026-11-26T11:23:10.027Z",
    agrees: true,
    credits: 1,
  };
  const reading = await readShareStake(["NVDA", "TSLA", "GOLD"], 0.625, {
    quote: async () => ({ quotes, credits: 2 }),
    compare: async () => comparison,
  });
  assert.equal(reading.fallbackSymbol, "TSLA");
  assert.equal(reading.comparison.agrees, true);
  assert.equal(reading.credits, 3);
});

test("a wallet of more than five shares locks the worst change that covers the stake", () => {
  const symbols = ["AAPL", "MSFT", "AMZN", "GOOGL", "META", "NVDA", "TSLA", "GOLD"];
  const quotes: ShareQuote[] = symbols.map((symbol, index) => ({
    symbol,
    name: symbol,
    priceUsd: 100,
    percentChange24h: index - 4,
  }));
  quotes.find((quote) => quote.symbol === "AAPL")!.percentChange24h = -9;
  quotes.find((quote) => quote.symbol === "MSFT")!.percentChange24h = -3;
  const one = 10n ** 18n;
  const holdings: ShareHolding[] = symbols.map((symbol) => ({
    symbol,
    token: `0x${symbol.charCodeAt(0).toString(16).padStart(40, "0")}`,
    balance: one,
    decimals: 18,
  }));
  const aapl = holdings.find((holding) => holding.symbol === "AAPL");
  if (!aapl) throw new Error("missing AAPL");
  aapl.balance = one / 1000n;
  const chosen = chooseShare(quotes, holdings, 1);
  assert.equal(chosen?.symbol, "MSFT");
});

test("equal 24-hour changes break by token address across a long book", () => {
  const quotes: ShareQuote[] = ["A", "B", "C", "D", "E", "F"].map((symbol) => ({
    symbol,
    name: symbol,
    priceUsd: 10,
    percentChange24h: -1,
  }));
  const holdings: ShareHolding[] = quotes.map((quote, index) => ({
    symbol: quote.symbol,
    token: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    balance: 10n ** 18n,
  }));
  const chosen = chooseShare(quotes, holdings, 1);
  assert.equal(chosen?.symbol, "A");
  assert.equal(chosen?.token, `0x${"1".padStart(40, "0")}`);
});
