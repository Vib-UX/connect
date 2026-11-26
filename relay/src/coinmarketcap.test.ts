import assert from "node:assert/strict";
import test from "node:test";
import { CmcError, compareWithFearAndGreed, quoteShares, readingsAgree } from "./coinmarketcap.js";

const rwa = {
  data: {
    rwa_assets: [
      {
        symbol: "NVDA",
        name: "Nvidia Corp",
        average_tokenized_price: 180.5,
        tokens: [
          { crypto_id: 11, price: 180, volume_24h: 10 },
          { crypto_id: 22, price: 181, volume_24h: 90 },
        ],
      },
      {
        symbol: "GOLD",
        name: "Gold",
        average_tokenized_price: 4000,
        tokens: [{ crypto_id: 33, price: 4000, volume_24h: 5 }],
      },
    ],
  },
  status: { error_code: 0, error_message: "", credit_count: 1 },
};

const tokens = {
  data: [
    { id: 22, quote: [{ symbol: "USD", percent_change_24h: -1.25 }] },
    { id: 33, quote: [{ symbol: "USD", percent_change_24h: 0.5 }] },
  ],
  status: { error_code: "0", error_message: "", credit_count: "1" },
};

function fakeFetch(seen: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const header = new Headers(init?.headers).get("X-CMC_PRO_API_KEY");
    assert.equal(header, "test-key");
    const body = url.includes("/v5/real-world-assets/") ? rwa : tokens;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

test("quoteShares uses the server key and keeps the busiest wrapper's 24h change", async () => {
  process.env.CMC_API_KEY = "test-key";
  const seen: string[] = [];
  const result = await quoteShares(["nvda", "GOLD", "nvda"], fakeFetch(seen));
  assert.equal(seen.length, 2);
  assert.match(seen[0], /symbol=NVDA%2CGOLD/);
  assert.match(seen[1], /id=22%2C33|id=22,33/);
  assert.deepEqual(result.quotes, [
    { symbol: "NVDA", name: "Nvidia Corp", priceUsd: 180.5, percentChange24h: -1.25 },
    { symbol: "GOLD", name: "Gold", priceUsd: 4000, percentChange24h: 0.5 },
  ]);
  assert.equal(result.credits, 2);
  delete process.env.CMC_API_KEY;
});

test("a down Cournot reading agrees with fear and disagrees with greed", () => {
  assert.equal(readingsAgree(0.625, 24), true);
  assert.equal(readingsAgree(0.625, 72), false);
  assert.equal(readingsAgree(0.4, 72), true);
});

test("compareWithFearAndGreed keeps both readings", async () => {
  process.env.CMC_API_KEY = "test-key";
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        data: { value: 24, value_classification: "Fear", update_time: "2026-11-26T08:00:00.000Z" },
        status: { error_code: "0", error_message: "", credit_count: 1 },
      }),
      { status: 200 },
    )) as typeof fetch;
  const result = await compareWithFearAndGreed(0.625, fetchImpl);
  assert.equal(result.fearGreed, 24);
  assert.equal(result.classification, "Fear");
  assert.equal(result.agrees, true);
  assert.equal(result.credits, 1);
  delete process.env.CMC_API_KEY;
});

test("quoteShares refuses to run without a key", async () => {
  delete process.env.CMC_API_KEY;
  await assert.rejects(() => quoteShares(["NVDA"], fakeFetch([])), CmcError);
});
