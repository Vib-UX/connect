import assert from "node:assert/strict";
import test from "node:test";
import type { MarketComparison, ShareQuote } from "./coinmarketcap.js";
import { readShareStake } from "./shareStake.js";

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
