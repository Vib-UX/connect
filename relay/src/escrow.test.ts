import assert from "node:assert/strict";
import test from "node:test";
import type WebSocket from "ws";
import { PlayBank, STAKE_USDC } from "./bank.js";
import { MemoryEscrow, STAKE_USDT, SUGGESTED_DEPOSIT_USDT, formatUsdt, parseStake } from "./escrow.js";
import { RelayStore } from "./store.js";
import type { ServerMessage, ConnectId } from "./types.js";

const ADA = `0x${"11".repeat(20)}` as const;
const BOB = `0x${"22".repeat(20)}` as const;
const A = "conn_escrow_a" as ConnectId;
const B = "conn_escrow_b" as ConnectId;

function fakeSocket() {
  const sent: ServerMessage[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send(raw: string) {
      sent.push(JSON.parse(raw) as ServerMessage);
    },
    close() {},
  };
  return { ws: ws as unknown as WebSocket, sent };
}

function last<T extends ServerMessage["type"]>(sent: ServerMessage[], type: T) {
  const found = [...sent].reverse().find((msg) => msg.type === type);
  assert.ok(found, `expected ${type}`);
  return found as Extract<ServerMessage, { type: T }>;
}

async function tick(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("testnet amounts are 0.1 deposit and 0.001 stake", () => {
  // Default CONNECT_ESCROW_CHAIN_ID is 97 (BSC testnet).
  assert.equal(formatUsdt(SUGGESTED_DEPOSIT_USDT), "$0.10");
  assert.equal(formatUsdt(STAKE_USDT), "$0.001");
  assert.equal(parseStake("0"), 0n);
  assert.equal(parseStake(STAKE_USDT.toString()), STAKE_USDT);
});

test("a 0.1 escrow balance covers many 0.001 staked matches without another deposit", async () => {
  const escrow = new MemoryEscrow();
  escrow.credit(ADA, SUGGESTED_DEPOSIT_USDT);
  escrow.credit(BOB, SUGGESTED_DEPOSIT_USDT);
  const bank = new PlayBank();
  const store = new RelayStore({ bank, requireDeposit: true, escrow });
  const ada = fakeSocket();
  const bob = fakeSocket();
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(
    ada.ws,
    JSON.stringify({
      type: "hello",
      identity: { id: A, displayName: "ada", host: "cursor", walletAddress: ADA, chainId: 97 },
    }),
  );
  store.handle(
    bob.ws,
    JSON.stringify({
      type: "hello",
      identity: { id: B, displayName: "bob", host: "claude", walletAddress: BOB, chainId: 97 },
    }),
  );

  store.handle(ada.ws, JSON.stringify({ type: "next" }));
  await tick();
  store.handle(bob.ws, JSON.stringify({ type: "next" }));
  await tick(80);

  assert.equal(escrow.locks.length, 1);
  assert.equal(escrow.locks[0]?.stake, STAKE_USDT);
  const match1 = last(ada.sent, "match").match;
  assert.equal(match1.status, "active");
  assert.equal(match1.stakeWei, STAKE_USDT.toString());
  assert.equal(await escrow.balanceOf(ADA), SUGGESTED_DEPOSIT_USDT - STAKE_USDT);
  assert.equal(bank.balanceOf(ADA, 97), 0n);

  const loser = match1.white;
  const winner = match1.black;
  store.handle(
    loser === A ? ada.ws : bob.ws,
    JSON.stringify({ type: "resign", matchId: match1.matchId }),
  );
  await tick(80);

  assert.equal(escrow.settles.length, 1);
  assert.equal(escrow.settles[0]?.betId, match1.matchId);
  assert.equal(escrow.settles[0]?.outcome, "b_wins");
  const winnerSock = winner === A ? ada : bob;
  const loserSock = loser === A ? ada : bob;
  const won = last(winnerSock.sent, "bank").bank;
  const lost = last(loserSock.sent, "bank").bank;
  assert.equal(won.ledger[0]?.line, "Won on BNB testnet.");
  assert.match(won.ledger[0]?.href ?? "", /testnet\.bscscan\.com\/tx\/0x2222/);
  assert.equal(lost.ledger[0]?.line, "Lost on BNB testnet.");
  assert.equal(lost.ledger[0]?.href, won.ledger[0]?.href);
  assert.equal(bank.balanceOf(ADA, 97), 0n);
  assert.equal(bank.balanceOf(BOB, 97), 0n);

  const winnerBal = await escrow.balanceOf(winner === A ? ADA : BOB);
  const loserBal = await escrow.balanceOf(loser === A ? ADA : BOB);
  assert.equal(winnerBal, SUGGESTED_DEPOSIT_USDT + STAKE_USDT);
  assert.equal(loserBal, SUGGESTED_DEPOSIT_USDT - STAKE_USDT);

  store.handle(ada.ws, JSON.stringify({ type: "next" }));
  await tick();
  store.handle(bob.ws, JSON.stringify({ type: "next" }));
  await tick(80);

  assert.equal(escrow.locks.length, 2);
  const match2 = last(ada.sent, "match").match;
  assert.notEqual(match2.matchId, match1.matchId);
  assert.equal(match2.status, "active");
});

test("a short escrow balance blocks the start", async () => {
  const escrow = new MemoryEscrow();
  escrow.credit(ADA, STAKE_USDT / 2n);
  escrow.credit(BOB, SUGGESTED_DEPOSIT_USDT);
  const store = new RelayStore({ requireDeposit: true, escrow });
  const ada = fakeSocket();
  const bob = fakeSocket();
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(
    ada.ws,
    JSON.stringify({
      type: "hello",
      identity: { id: A, displayName: "ada", host: "cursor", walletAddress: ADA, chainId: 97 },
    }),
  );
  store.handle(
    bob.ws,
    JSON.stringify({
      type: "hello",
      identity: { id: B, displayName: "bob", host: "claude", walletAddress: BOB, chainId: 97 },
    }),
  );

  store.handle(ada.ws, JSON.stringify({ type: "next" }));
  await tick();
  const err = last(ada.sent, "error");
  assert.match(err.message, /Deposit \$0\.10 USDT on BNB testnet/);
  assert.equal(escrow.locks.length, 0);
  assert.equal(ada.sent.some((msg) => msg.type === "match"), false);
});

test("a staked win does not call PlayBank.take", async () => {
  const escrow = new MemoryEscrow();
  escrow.credit(ADA, SUGGESTED_DEPOSIT_USDT);
  escrow.credit(BOB, SUGGESTED_DEPOSIT_USDT);
  const bank = new PlayBank();
  bank.credit(ADA, `0x${"aa".repeat(32)}`, 1_000_000n, 56);
  bank.credit(BOB, `0x${"bb".repeat(32)}`, 1_000_000n, 56);
  const beforeA = bank.balanceOf(ADA, 56);
  const beforeB = bank.balanceOf(BOB, 56);

  const store = new RelayStore({ bank, requireDeposit: true, escrow });
  const ada = fakeSocket();
  const bob = fakeSocket();
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(
    ada.ws,
    JSON.stringify({
      type: "hello",
      identity: { id: A, displayName: "ada", host: "cursor", walletAddress: ADA, chainId: 97 },
    }),
  );
  store.handle(
    bob.ws,
    JSON.stringify({
      type: "hello",
      identity: { id: B, displayName: "bob", host: "claude", walletAddress: BOB, chainId: 97 },
    }),
  );
  store.handle(ada.ws, JSON.stringify({ type: "next" }));
  await tick();
  store.handle(bob.ws, JSON.stringify({ type: "next" }));
  await tick(80);
  const match = last(ada.sent, "match").match;
  store.handle(ada.ws, JSON.stringify({ type: "resign", matchId: match.matchId }));
  await tick(80);

  assert.equal(escrow.settles.length, 1);
  assert.equal(bank.balanceOf(ADA, 56), beforeA);
  assert.equal(bank.balanceOf(BOB, 56), beforeB);
  assert.ok(STAKE_USDC > 0n);
});
