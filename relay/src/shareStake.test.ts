import assert from "node:assert/strict";
import test from "node:test";
import type { MarketComparison, ShareQuote } from "./coinmarketcap.js";
import {
  chooseShare,
  lockTokensForPlayers,
  readShareStake,
  type ShareHolding,
} from "./shareStake.js";

const NVDAB = "0x876904e7b854f17A5582524aa5028124240f0e8E";
const XAUT = "0x73888097E35C7105aE80022ae2A8beaAc1435E73";
const USDT = "0x27Ae80b8eE17ffbCFCf38469A018A942BC8f8Ba9";

const nvdaGoldQuotes: ShareQuote[] = [
  { symbol: "NVDA", name: "Nvidia Corp", priceUsd: 150, percentChange24h: 1.7 },
  { symbol: "GOLD", name: "Gold", priceUsd: 3558, percentChange24h: -0.4 },
];

const bothShares: ShareHolding[] = [
  { symbol: "NVDA", token: NVDAB, balance: 10n ** 18n, decimals: 18 },
  { symbol: "GOLD", token: XAUT, balance: 10n ** 18n, decimals: 18 },
];

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

test("when Cournot and Fear and Greed lean the same way, lock the worst covering share", () => {
  const chosen = lockTokensForPlayers(nvdaGoldQuotes, bothShares, bothShares, 1, true, USDT);
  assert.equal(chosen.symbolA, "GOLD");
  assert.equal(chosen.tokenA, XAUT);
  assert.equal(chosen.symbolB, "GOLD");
  assert.equal(chosen.tokenB, XAUT);
});

test("when Cournot and Fear and Greed lean apart, lock the best covering share", () => {
  const chosen = lockTokensForPlayers(nvdaGoldQuotes, bothShares, bothShares, 1, false, USDT);
  assert.equal(chosen.symbolA, "NVDA");
  assert.equal(chosen.tokenA, NVDAB);
  assert.equal(chosen.symbolB, "NVDA");
  assert.equal(chosen.tokenB, NVDAB);
});

test("a player with no covering share locks USDT while the other can lock a share", () => {
  const empty: ShareHolding[] = [];
  const chosen = lockTokensForPlayers(nvdaGoldQuotes, bothShares, empty, 1, true, USDT);
  assert.equal(chosen.tokenA, XAUT);
  assert.equal(chosen.symbolA, "GOLD");
  assert.equal(chosen.tokenB, USDT);
  assert.equal(chosen.symbolB, null);
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

test("when readings lean apart, equal changes still break by token address", () => {
  const quotes: ShareQuote[] = ["A", "B"].map((symbol) => ({
    symbol,
    name: symbol,
    priceUsd: 10,
    percentChange24h: 2,
  }));
  const holdings: ShareHolding[] = [
    { symbol: "A", token: `0x${"2".padStart(40, "0")}`, balance: 10n ** 18n },
    { symbol: "B", token: `0x${"1".padStart(40, "0")}`, balance: 10n ** 18n },
  ];
  const chosen = chooseShare(quotes, holdings, 1, "best");
  assert.equal(chosen?.symbol, "B");
  assert.equal(chosen?.token, `0x${"1".padStart(40, "0")}`);
});
