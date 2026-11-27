import assert from "node:assert/strict";
import test from "node:test";
import { cournotDownProbability, downClaim, pickMarketId, type CournotRunner } from "./cournot.js";

test("the down claim is the held share over the next 24 hours", () => {
  assert.equal(downClaim("NVDA"), "NVIDIA price finishes down over the next 24 hours");
  assert.equal(downClaim("GOLD"), "gold price finishes down over the next 24 hours");
  assert.equal(downClaim("AAPL"), "AAPL price finishes down over the next 24 hours");
});

test("a single resolve result is used", () => {
  assert.equal(pickMarketId([{ matching_confidence: 0.4, market_info: { id: "11" } }]), "11");
});

test("a clear resolve leader is used", () => {
  assert.equal(
    pickMarketId([
      { matching_confidence: 0.9, market_info: { id: "21" } },
      { matching_confidence: 0.5, market_info: { id: "22" } },
    ]),
    "21",
  );
});

test("an unclear resolve field abstains", () => {
  assert.equal(
    pickMarketId([
      { matching_confidence: 0.7, market_info: { id: "31" } },
      { matching_confidence: 0.65, market_info: { id: "32" } },
    ]),
    null,
  );
});

test("Cournot is called once per held share and the book lean is the mean", async () => {
  const calls: Array<{ command: string; body: unknown }> = [];
  const run: CournotRunner = async (command, body) => {
    calls.push({ command, body });
    const message = (body as { message: string }).message;
    if (command === "resolve") {
      const id = message.startsWith("NVIDIA") ? "nvda-down" : "gold-down";
      return { response: { data: { markets: [{ matching_confidence: 0.92, market_info: { id } }] } } };
    }
    const probability = message.startsWith("NVIDIA") ? 0.4 : 0.8;
    return { state: "complete", response: { data: { probability } } };
  };
  const probability = await cournotDownProbability(["NVDA", "GOLD", "nvda"], run);
  assert.equal(Number(probability.toFixed(10)), 0.6);
  assert.equal(calls.filter((call) => call.command === "resolve").length, 2);
  assert.equal(calls.filter((call) => call.command === "prepare").length, 2);
  assert.deepEqual(
    calls.filter((call) => call.command === "prepare").map((call) => (call.body as { market_ids: string[] }).market_ids[0]),
    ["nvda-down", "gold-down"],
  );
});

test("a share with no Cournot market is skipped", async () => {
  const run: CournotRunner = async (command, body) => {
    const message = (body as { message: string }).message;
    if (command === "resolve") {
      if (message.startsWith("NVIDIA")) return { response: { data: { markets: [] } } };
      return { response: { data: { markets: [{ matching_confidence: 0.99, market_info: { id: "gold-down" } }] } } };
    }
    return { state: "complete", response: { data: { probability: 0.7 } } };
  };
  assert.equal(await cournotDownProbability(["NVDA", "GOLD"], run), 0.7);
});

test("Cournot fails when no held share matches a market", async () => {
  const run: CournotRunner = async () => ({ response: { data: { markets: [] } } });
  await assert.rejects(cournotDownProbability(["NVDA"], run), /did not match a market/);
});
