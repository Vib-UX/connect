import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type WebSocket from "ws";
import { PlayBank, STAKE_USDC, ccipHref, depositFromBlock, formatUsdc, logRanges, logSpan, payoutReceipt, stakeChain, transferLine, txHref } from "./bank.js";
import { RelayStore } from "./store.js";
import type { ServerMessage, ConnectId } from "./types.js";

const ADA = `0x${"11".repeat(20)}` as const;
const BOB = `0x${"22".repeat(20)}` as const;
const ADA_TX = `0x${"ab".repeat(32)}`;
const BOB_TX = `0x${"cd".repeat(32)}`;
const A = "conn_bank_a" as ConnectId;
const B = "conn_bank_b" as ConnectId;

function fakeSocket() {
  const sent: ServerMessage[] = [];
  const ws = {
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

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

test("a $1 deposit stays playable, and two losses leave $0.90", async () => {
  const bank = new PlayBank(null, async () => [{ txHash: ADA_TX, amount: 1_000_000n }]);
  const store = new RelayStore({ bank });
  const ada = fakeSocket();
  store.add(ada.ws);
  store.handle(ada.ws, JSON.stringify({
    type: "hello",
    identity: { id: A, displayName: "ada", host: "cursor", walletAddress: ADA, chainId: 97 },
  }));
  await settled();
  const view = last(ada.sent, "bank").bank;
  assert.equal(view.balanceUsd, "$1.00");
  assert.equal(view.canPlay, true);
  assert.equal(bank.balanceOf(ADA, 97), 1_000_000n);
  assert.equal(bank.take(ADA, BOB, STAKE_USDC, 97, 97), true);
  assert.equal(bank.take(ADA, BOB, STAKE_USDC, 97, 97), true);
  assert.equal(bank.balanceOf(ADA, 97), 900_000n);
  assert.equal(formatUsdc(bank.balanceOf(ADA, 97)), "$0.90");
});

test("a deposit from earlier the same day is still inside the scan window", () => {
  const latest = 54_178_661n;
  const headTime = 1_700_000_000n;
  const sampleBlock = latest - 2_000n;
  const sampleTime = headTime - 400n;
  const from = depositFromBlock(latest, headTime, sampleBlock, sampleTime);
  const depositedAt = 54_133_873n;
  assert.ok(from < depositedAt);
  assert.ok(latest - from >= 49_000n);
});

test("log pages stay inside the RPC limit", () => {
  assert.ok(logSpan(97) <= 10_000n);
  assert.equal(logSpan(56), 9_000n);
  const latest = 1_000_000n;
  const from = latest - 130_000n;
  const depositedAt = latest - 5_620n;
  const ranges = logRanges(from, latest, logSpan(10));
  assert.ok(ranges.length > 1);
  assert.equal(ranges[0]?.from, from);
  assert.equal(ranges[ranges.length - 1]?.to, latest);
  for (const range of ranges) {
    assert.ok(range.to - range.from + 1n <= 10_000n);
    assert.ok(range.to >= range.from);
  }
  assert.ok(ranges.some((range) => depositedAt >= range.from && depositedAt <= range.to));
  assert.equal(formatUsdc(1_200_000n), "$1.20");
});

test("a dollar formats as $1.00 and a game as $0.05", () => {
  assert.equal(formatUsdc(1_000_000n), "$1.00");
  assert.equal(formatUsdc(STAKE_USDC), "$0.05");
  assert.equal(formatUsdc(1_050_000n), "$1.05");
  assert.equal(transferLine("won", "BNB testnet", "BNB Chain"), "Sending $0.05 from their BNB testnet to your BNB Chain.");
  assert.equal(
    transferLine("lost", "BNB testnet", "BNB Chain", "https://testnet.bscscan.com/tx/0xabc"),
    "Settlement from your BNB testnet to their BNB Chain. https://testnet.bscscan.com/tx/0xabc",
  );
  assert.equal(transferLine("lost", "BNB Chain", "BNB testnet"), "Sending $0.05 from your BNB Chain to their BNB testnet.");
});

test("a send link is the chain transaction, or the CCIP message when the send crosses chains", () => {
  const hash = `0x${"ab".repeat(32)}`;
  const message = `0x${"cd".repeat(32)}`;
  assert.equal(txHref("BNB testnet", hash), `https://testnet.bscscan.com/tx/${hash}`);
  assert.equal(txHref("BNB Chain", hash), `https://bscscan.com/tx/${hash}`);
  assert.equal(txHref("BNB testnet", "0x123"), null);
  assert.equal(ccipHref(message), `https://ccip.chain.link/msg/${message}`);
  assert.equal(ccipHref(`0x${"00".repeat(32)}`), null);
  const same = payoutReceipt({ txHash: hash, chainName: "BNB testnet" }, "$1.05");
  assert.equal(same?.href, `https://testnet.bscscan.com/tx/${hash}`);
  assert.equal(same?.ccipHref, null);
  const crossed = payoutReceipt({ txHash: hash, chainName: "BNB Chain", messageId: message }, "$0.05");
  assert.equal(crossed?.ccipHref, `https://ccip.chain.link/msg/${message}`);
});

test("a deposit is credited once and a short balance does not move", () => {
  const bank = new PlayBank(null, async () => []);
  assert.equal(bank.credit(ADA, ADA_TX, 1_000_000n), true);
  assert.equal(bank.credit(ADA, ADA_TX, 1_000_000n), false);
  assert.equal(bank.balanceOf(ADA), 1_000_000n);
  assert.equal(bank.take(ADA, BOB, STAKE_USDC), true);
  assert.equal(bank.balanceOf(ADA), 950_000n);
  assert.equal(bank.balanceOf(BOB), STAKE_USDC);
  assert.equal(bank.take(ADA, ADA, STAKE_USDC), false);
  assert.equal(bank.take(BOB, ADA, 1_000_000n), false);
  assert.equal(bank.balanceOf(BOB), STAKE_USDC);
});

test("claim holds the balance until it is finished or restored", () => {
  const bank = new PlayBank(null, async () => []);
  bank.credit(ADA, ADA_TX, 1_000_000n);
  assert.equal(bank.reserveClaim(ADA), 1_000_000n);
  assert.equal(bank.balanceOf(ADA), 0n);
  assert.throws(() => bank.reserveClaim(ADA), /in progress/);
  bank.restore(ADA, 1_000_000n);
  assert.equal(bank.balanceOf(ADA), 1_000_000n);
  assert.equal(bank.reserveClaim(ADA), 1_000_000n);
  bank.finishClaim(ADA);
  assert.equal(bank.balanceOf(ADA), 0n);
});

test("a BNB Chain balance does not include a BNB testnet deposit", () => {
  const bank = new PlayBank(null, async () => []);
  assert.equal(bank.credit(ADA, ADA_TX, 1_000_000n, 56), true);
  assert.equal(bank.credit(ADA, BOB_TX, 1_200_000n, 97), true);
  assert.equal(bank.balanceOf(ADA, 56), 1_000_000n);
  assert.equal(bank.balanceOf(ADA, 97), 1_200_000n);
});

test("the bank file remembers a deposit across opens", () => {
  const dir = mkdtempSync(join(tmpdir(), "connect-bank-"));
  const file = join(dir, "bank.json");
  const first = PlayBank.open(file);
  first.credit(ADA, ADA_TX, 1_000_000n);
  const second = PlayBank.open(file);
  assert.equal(second.balanceOf(ADA), 1_000_000n);
  assert.equal(second.credit(ADA, ADA_TX, 1_000_000n), false);
});

test("flappy moves $0.05 from the loser chain balance to the winner", () => {
  const bank = new PlayBank(null, async () => []);
  bank.credit(ADA, ADA_TX, 1_000_000n, 56);
  bank.credit(BOB, BOB_TX, 1_000_000n, 97);
  const store = new RelayStore({ bank });
  const ada = fakeSocket();
  const bob = fakeSocket();
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(ada.ws, JSON.stringify({
    type: "hello",
    identity: { id: A, displayName: "ada", host: "cursor", walletAddress: ADA, chainId: 56 },
  }));
  store.handle(bob.ws, JSON.stringify({
    type: "hello",
    identity: { id: B, displayName: "bob", host: "claude", walletAddress: BOB, chainId: 97 },
  }));
  store.handle(ada.ws, JSON.stringify({ type: "flappy_join" }));
  store.handle(bob.ws, JSON.stringify({ type: "flappy_join" }));
  const start = last(ada.sent, "flappy");
  store.handle(ada.ws, JSON.stringify({ type: "flappy_score", contestId: start.flappy.id, score: 4 }));
  store.handle(bob.ws, JSON.stringify({ type: "flappy_score", contestId: start.flappy.id, score: 2 }));

  assert.equal(bank.balanceOf(ADA, 56), 1_050_000n);
  assert.equal(bank.balanceOf(BOB, 97), 950_000n);
  const adaBank = last(ada.sent, "bank");
  const bobBank = last(bob.sent, "bank");
  assert.equal(adaBank.bank.balanceUsd, "$1.05");
  assert.equal(adaBank.bank.note, "Balance updated. Claim it whenever you want.");
  assert.equal(last(ada.sent, "flappy").flappy.balanceUsd, "$1.05");
  assert.equal(last(bob.sent, "flappy").flappy.balanceUsd, "$0.95");
  assert.equal(adaBank.bank.depositUsd, "$1.00");
  assert.equal(adaBank.bank.transfer?.line, "Sending $0.05 from their BNB testnet to your BNB Chain.");
  assert.equal(adaBank.bank.transfer?.href ?? null, null);
  assert.equal(bobBank.bank.transfer?.line, "Sending $0.05 from your BNB testnet to their BNB Chain.");
  assert.equal(last(ada.sent, "flappy").flappy.stake, "Sending $0.05 from their BNB testnet to your BNB Chain.");
});

test("a game without a deposit asks for $1.00 and leaves balances alone", () => {
  const bank = new PlayBank(null, async () => []);
  const store = new RelayStore({ bank });
  const ada = fakeSocket();
  const bob = fakeSocket();
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(ada.ws, JSON.stringify({
    type: "hello",
    identity: { id: A, displayName: "ada", host: "cursor", walletAddress: ADA, chainId: 97 },
  }));
  store.handle(bob.ws, JSON.stringify({
    type: "hello",
    identity: { id: B, displayName: "bob", host: "claude", walletAddress: BOB, chainId: 97 },
  }));
  store.handle(ada.ws, JSON.stringify({ type: "flappy_join" }));
  store.handle(bob.ws, JSON.stringify({ type: "flappy_join" }));
  const start = last(ada.sent, "flappy");
  store.handle(ada.ws, JSON.stringify({ type: "flappy_score", contestId: start.flappy.id, score: 3 }));
  store.handle(bob.ws, JSON.stringify({ type: "flappy_score", contestId: start.flappy.id, score: 1 }));
  assert.equal(bank.balanceOf(ADA), 0n);
  assert.equal(bank.balanceOf(BOB), 0n);
  assert.equal(last(ada.sent, "bank").bank.transfer?.line, "Deposit $1.00 USDT to cover the $0.05.");
});

test("chess resign moves $0.05 to the player who stays", () => {
  const bank = new PlayBank(null, async () => []);
  bank.credit(ADA, ADA_TX, 1_000_000n, 1);
  bank.credit(BOB, BOB_TX, 1_000_000n, 137);
  const store = new RelayStore({ bank });
  const ada = fakeSocket();
  const bob = fakeSocket();
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(ada.ws, JSON.stringify({
    type: "hello",
    identity: { id: A, displayName: "ada", host: "web", walletAddress: ADA, chainId: 1 },
  }));
  store.handle(bob.ws, JSON.stringify({
    type: "hello",
    identity: { id: B, displayName: "bob", host: "web", walletAddress: BOB, chainId: 137 },
  }));
  store.handle(ada.ws, JSON.stringify({ type: "challenge", to: B, stakeWei: "0" }));
  const challenge = last(bob.sent, "challenge");
  store.handle(bob.ws, JSON.stringify({ type: "respond_challenge", challengeId: challenge.challenge.id, accept: true }));
  const match = last(ada.sent, "match");
  store.handle(ada.ws, JSON.stringify({ type: "resign", matchId: match.match.matchId }));
  assert.equal(bank.balanceOf(ADA, 1), 950_000n);
  assert.equal(bank.balanceOf(BOB, 137), 1_050_000n);
  assert.equal(last(bob.sent, "bank").bank.balanceUsd, "$1.05");
  assert.equal(last(bob.sent, "bank").bank.canClaim, true);
  assert.equal(last(ada.sent, "bank").bank.balanceUsd, "$0.95");
  assert.equal(last(bob.sent, "bank").bank.note, "Balance updated. Claim it whenever you want.");
  assert.match(last(bob.sent, "bank").bank.transfer?.line ?? "", /\$0\.05 from their chain to your chain/);
});

test("a loss moves $0.05 from BNB testnet to BNB Chain", () => {
  assert.equal(stakeChain({}), 97);
  assert.equal(stakeChain(undefined), 97);
  assert.equal(stakeChain({ chainId: 56 }), 56);
  assert.equal(stakeChain({ chainId: 97 }), 97);
  const bank = new PlayBank(null, async () => []);
  bank.credit(ADA, ADA_TX, 1_000_000n, 97);
  bank.credit(ADA, BOB_TX, 1_000_000n, 56);
  const store = new RelayStore({ bank });
  const claude = fakeSocket();
  const cursor = fakeSocket();
  store.add(claude.ws);
  store.add(cursor.ws);
  store.handle(claude.ws, JSON.stringify({
    type: "hello",
    identity: { id: A, displayName: "claude", host: "claude", walletAddress: ADA },
  }));
  store.handle(cursor.ws, JSON.stringify({
    type: "hello",
    identity: { id: B, displayName: "cursor", host: "cursor", walletAddress: ADA, chainId: 56 },
  }));
  store.handle(claude.ws, JSON.stringify({ type: "challenge", to: B, stakeWei: "0" }));
  const challenge = last(cursor.sent, "challenge");
  store.handle(cursor.ws, JSON.stringify({ type: "respond_challenge", challengeId: challenge.challenge.id, accept: true }));
  const match = last(claude.sent, "match");
  store.handle(claude.ws, JSON.stringify({ type: "resign", matchId: match.match.matchId }));
  assert.equal(bank.balanceOf(ADA, 97), 950_000n);
  assert.equal(bank.balanceOf(ADA, 56), 1_050_000n);
  assert.equal(last(claude.sent, "bank").bank.balanceUsd, "$0.95");
  assert.equal(last(claude.sent, "bank").bank.transfer?.line, "Sending $0.05 from your BNB testnet to their BNB Chain.");
  assert.equal(last(claude.sent, "bank").bank.transfer?.href ?? null, null);
  assert.equal(last(cursor.sent, "bank").bank.balanceUsd, "$1.05");
});

test("the CCIP link is the stake send from this game", async () => {
  const bank = new PlayBank(null, async () => []);
  bank.credit(ADA, ADA_TX, 1_000_000n, 97);
  bank.credit(BOB, BOB_TX, 1_000_000n, 56);
  const messageId = `0x${"cd".repeat(32)}`;
  const seen: Array<{ fromChainId: number; toChainId: number; wallet: string; amount: bigint }> = [];
  const store = new RelayStore({
    bank,
    stakeSender: async (input) => {
      seen.push(input);
      return { txHash: `0x${"ab".repeat(32)}`, messageId };
    },
  });
  const claude = fakeSocket();
  const cursor = fakeSocket();
  store.add(claude.ws);
  store.add(cursor.ws);
  store.handle(claude.ws, JSON.stringify({
    type: "hello",
    identity: { id: A, displayName: "claude", host: "claude", walletAddress: ADA, chainId: 97 },
  }));
  store.handle(cursor.ws, JSON.stringify({
    type: "hello",
    identity: { id: B, displayName: "cursor", host: "cursor", walletAddress: BOB, chainId: 56 },
  }));
  store.handle(claude.ws, JSON.stringify({ type: "challenge", to: B, stakeWei: "0" }));
  const challenge = last(cursor.sent, "challenge");
  store.handle(cursor.ws, JSON.stringify({ type: "respond_challenge", challengeId: challenge.challenge.id, accept: true }));
  const match = last(claude.sent, "match");
  store.handle(claude.ws, JSON.stringify({ type: "resign", matchId: match.match.matchId }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.fromChainId, 97);
  assert.equal(seen[0]?.toChainId, 56);
  assert.equal(seen[0]?.wallet, BOB);
  assert.equal(seen[0]?.amount, STAKE_USDC);
  const href = `https://ccip.chain.link/msg/${messageId}`;
  assert.equal(last(claude.sent, "bank").bank.transfer?.href, href);
  assert.equal(
    last(claude.sent, "bank").bank.transfer?.line,
    `Settlement from your BNB testnet to their BNB Chain. ${href}`,
  );
});

test("a rematch starts only after both players ask, and the claimable balance stays", () => {
  const bank = new PlayBank(null, async () => []);
  bank.credit(ADA, ADA_TX, 1_000_000n, 1);
  bank.credit(BOB, BOB_TX, 1_000_000n, 137);
  const store = new RelayStore({ bank });
  const ada = fakeSocket();
  const bob = fakeSocket();
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(ada.ws, JSON.stringify({
    type: "hello",
    identity: { id: A, displayName: "ada", host: "web", walletAddress: ADA, chainId: 1 },
  }));
  store.handle(bob.ws, JSON.stringify({
    type: "hello",
    identity: { id: B, displayName: "bob", host: "web", walletAddress: BOB, chainId: 137 },
  }));
  store.handle(ada.ws, JSON.stringify({ type: "challenge", to: B, stakeWei: "0" }));
  const challenge = last(bob.sent, "challenge");
  store.handle(bob.ws, JSON.stringify({ type: "respond_challenge", challengeId: challenge.challenge.id, accept: true }));
  const finishedId = last(ada.sent, "match").match.matchId;
  store.handle(ada.ws, JSON.stringify({ type: "resign", matchId: finishedId }));

  store.handle(ada.ws, JSON.stringify({ type: "rematch", game: "chess" }));
  assert.equal(last(ada.sent, "rematch").offer?.waiting, true);
  assert.equal(last(bob.sent, "rematch").offer?.waiting, false);
  assert.equal(last(bob.sent, "rematch").offer?.fromName, "ada");
  assert.equal(last(ada.sent, "match").match.matchId, finishedId);

  store.handle(bob.ws, JSON.stringify({ type: "rematch", game: "chess" }));
  const next = last(ada.sent, "match").match;
  assert.equal(next.status, "active");
  assert.notEqual(next.matchId, finishedId);
  assert.equal(last(ada.sent, "rematch").offer, null);
  assert.equal(bank.balanceOf(ADA, 1), 950_000n);
  assert.equal(bank.balanceOf(BOB, 137), 1_050_000n);
  assert.equal(last(bob.sent, "bank").bank.canClaim, true);
});

test("play stays closed until a deposit covers $0.05", () => {
  const bank = new PlayBank(null, async () => []);
  const store = new RelayStore({ bank, requireDeposit: true });
  const ada = fakeSocket();
  store.add(ada.ws);
  store.handle(ada.ws, JSON.stringify({
    type: "hello",
    identity: { id: A, displayName: "ada", host: "web", walletAddress: ADA, chainId: 1 },
  }));
  assert.equal(last(ada.sent, "bank").bank.canPlay, false);
  store.handle(ada.ws, JSON.stringify({ type: "flappy_join" }));
  assert.match(last(ada.sent, "error").message, /Deposit USDT on BNB testnet/);
  store.handle(ada.ws, JSON.stringify({ type: "next" }));
  assert.match(last(ada.sent, "error").message, /Deposit USDT on BNB testnet/);
  bank.credit(ADA, ADA_TX, 1_000_000n, 1);
  store.handle(ada.ws, JSON.stringify({ type: "flappy_join" }));
  assert.equal(last(ada.sent, "flappy").flappy.status, "waiting");
});
