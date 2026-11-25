import assert from "node:assert/strict";
import test from "node:test";
import { centsToUsdc, choosePayout, extraArgsV3, laneForChain } from "./treasury.js";

test("mainnet lanes reject testnets", () => {
  assert.equal(laneForChain(97), null);
  assert.equal(laneForChain(56), null);
});

test("cents convert to 6-decimal token units", () => {
  assert.equal(centsToUsdc(75), 750_000n);
  assert.throws(() => centsToUsdc(0));
});

test("a claim uses the chain that can pay", () => {
  const rows = [
    { chainId: 97, balance: 1_000_000n },
    { chainId: 56, balance: 50_000n },
  ];
  assert.equal(choosePayout(56, rows, 50_000n), 56);
  assert.equal(choosePayout(56, rows, 1_000_000n), 97);
  assert.equal(choosePayout(1, rows, 50_000n), 97);
  assert.equal(choosePayout(137, rows, 2_000_000n), null);
});

test("extra args use the packed CCIP 2.0 v3 wire format", () => {
  assert.equal(extraArgsV3(), "0xa69dd4aa00000000000000000000000000000000");
});
