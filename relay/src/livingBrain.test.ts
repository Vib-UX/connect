import assert from "node:assert/strict";
import test from "node:test";
import type WebSocket from "ws";
import {
  livingBrainConfigured,
  minutesFromCost,
  predictPromptCost,
  scorePair,
  type BrainCapture,
  type PairSeat,
} from "./livingBrain.js";
import { RelayStore } from "./store.js";
import type { ConnectId, ServerMessage } from "./types.js";

const secret = "SECRET_PROMPT_TEXT build the living brain pairing check";

function seat(over: Partial<PairSeat> & Pick<PairSeat, "id" | "host">): PairSeat {
  return {
    costUsd: 0.02,
    minutesLeft: 8,
    waitedMs: 0,
    recentOpponent: false,
    playedToday: false,
    ...over,
  };
}

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

test("a prompt has a stable dollar estimate before any token counts exist", () => {
  const prompt = "a".repeat(400);
  const cost = predictPromptCost(prompt, "grok");
  assert.equal(cost, (100 * 2 + 400 * 6) / 1_000_000);
  assert.equal(minutesFromCost(cost) >= 2, cost >= 0.004);
  assert.equal(predictPromptCost("hi", "haiku") < predictPromptCost(prompt, "opus"), true);
});

test("similar cost beats a longer wait until the wait weight overtakes it", () => {
  const me = seat({ id: "me", host: "cursor", costUsd: 0.02 });
  const close = scorePair(me, seat({ id: "close", host: "cursor", costUsd: 0.02, waitedMs: 10_000 }));
  const far = scorePair(me, seat({ id: "far", host: "cursor", costUsd: 0.2, waitedMs: 10_000 }));
  assert.ok(close.score > far.score);
  const patient = scorePair(me, seat({ id: "far", host: "cursor", costUsd: 0.2, waitedMs: 220_000 }));
  assert.ok(patient.score > close.score);
});

test("a recent opponent ranks below a new one and stays eligible", () => {
  const me = seat({ id: "me", host: "cursor" });
  const fresh = scorePair(me, seat({ id: "new", host: "cursor" }));
  const recent = scorePair(me, seat({ id: "old", host: "cursor", recentOpponent: true, playedToday: true }));
  assert.ok(fresh.score > recent.score);
  assert.ok(recent.score > 0);
  assert.equal(recent.insight.playedToday, true);
  assert.match(recent.insight.reason, /played today/);
  assert.match(fresh.insight.reason, /First game today/);
});

test("different hosts rank above the same host", () => {
  const me = seat({ id: "me", host: "cursor" });
  const same = scorePair(me, seat({ id: "same", host: "cursor" }));
  const other = scorePair(me, seat({ id: "other", host: "claude" }));
  assert.ok(other.score > same.score);
});

test("a short bill recommends flappy and two longer bills recommend chess", () => {
  const quick = scorePair(
    seat({ id: "me", host: "cursor", minutesLeft: 0.5, costUsd: 0.001 }),
    seat({ id: "them", host: "claude", minutesLeft: 8, costUsd: 0.02 }),
  );
  assert.equal(quick.insight.game, "flappy");
  const long = scorePair(
    seat({ id: "me", host: "cursor", minutesLeft: 8, costUsd: 0.02 }),
    seat({ id: "them", host: "claude", minutesLeft: 6, costUsd: 0.03 }),
  );
  assert.equal(long.insight.game, "chess");
  assert.equal(long.insight.potUsd, 0.02);
});

test("the relay keeps the dollars and sends the prompt to the brain once", async () => {
  const seen: { text: string; originRef: string }[] = [];
  const brain: BrainCapture = {
    capture(input) {
      seen.push({ text: input.text, originRef: input.originRef });
      return Promise.resolve({ id: "src_1", status: "pending" });
    },
    search() {
      return Promise.resolve([]);
    },
  };
  const store = new RelayStore({ brain });
  const ada = fakeSocket();
  const bob = fakeSocket();
  const adaId = "conn_brainaaaa" as ConnectId;
  const bobId = "conn_brainbbbb" as ConnectId;
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(ada.ws, JSON.stringify({ type: "hello", identity: { id: adaId, displayName: "ada", host: "cursor" } }));
  store.handle(bob.ws, JSON.stringify({ type: "hello", identity: { id: bobId, displayName: "bob", host: "claude" } }));
  store.handle(
    ada.ws,
    JSON.stringify({ type: "next", prompt: secret, model: "grok", promptId: "prompt_ada" }),
  );
  store.handle(
    bob.ws,
    JSON.stringify({ type: "next", prompt: `${secret} again`, model: "grok", promptId: "prompt_bob" }),
  );

  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.text, secret);
  assert.equal(seen[0]?.originRef, "prompt_ada");
  const adaSession = store.sessionFor(adaId);
  assert.ok(adaSession);
  assert.equal(adaSession.costUsd, predictPromptCost(secret, "grok"));
  assert.equal(JSON.stringify(adaSession).includes(secret), false);
  assert.equal(JSON.stringify(ada.sent).includes(secret), false);
  assert.equal(JSON.stringify(bob.sent).includes(secret), false);
  const queue = [...ada.sent].reverse().find((msg) => msg.type === "queue");
  assert.equal(queue?.type, "queue");
  if (queue?.type === "queue") {
    assert.match(queue.insight?.reason ?? "", /covers both prompts/);
    assert.equal(queue.insight?.game, "flappy");
  }
});

test("a prompt is forwarded during a live game and does not resign it", () => {
  const seen: string[] = [];
  const brain: BrainCapture = {
    capture(input) {
      seen.push(input.text);
      return Promise.resolve({ id: "src_live", status: "pending" });
    },
    search() {
      return Promise.resolve([]);
    },
  };
  const store = new RelayStore({ brain });
  const ada = fakeSocket();
  const bob = fakeSocket();
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(ada.ws, JSON.stringify({ type: "hello", identity: { id: "conn_liveaaaa", displayName: "ada", host: "cursor" } }));
  store.handle(bob.ws, JSON.stringify({ type: "hello", identity: { id: "conn_livebbbb", displayName: "bob", host: "claude" } }));
  store.handle(ada.ws, JSON.stringify({ type: "next" }));
  store.handle(bob.ws, JSON.stringify({ type: "next" }));
  const before = ada.sent.filter((msg) => msg.type === "match").length;
  store.handle(ada.ws, JSON.stringify({ type: "prompt", prompt: secret, model: "grok", promptId: "prompt_live" }));
  assert.deepEqual(seen, [secret]);
  assert.equal(ada.sent.filter((msg) => msg.type === "match").length, before);
  assert.equal(store.sessionFor("conn_liveaaaa" as ConnectId)?.promptId, "prompt_live");
  assert.equal(JSON.stringify(ada.sent).includes(secret), false);
});

test("a named challenge does not capture the prompt", () => {
  const seen: string[] = [];
  const brain: BrainCapture = {
    capture(input) {
      seen.push(input.text);
      return Promise.resolve(null);
    },
    search() {
      return Promise.resolve([]);
    },
  };
  const store = new RelayStore({ brain });
  const ada = fakeSocket();
  const bob = fakeSocket();
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(ada.ws, JSON.stringify({ type: "hello", identity: { id: "conn_chaladaaa", displayName: "ada", host: "cursor" } }));
  store.handle(bob.ws, JSON.stringify({ type: "hello", identity: { id: "conn_chalbbbbb", displayName: "bob", host: "claude" } }));
  store.handle(ada.ws, JSON.stringify({ type: "challenge", to: "conn_chalbbbbb" }));
  assert.deepEqual(seen, []);
});

test("a missing key still pairs and does not capture", () => {
  const previous = process.env.LIVING_BRAIN_API_KEY;
  delete process.env.LIVING_BRAIN_API_KEY;
  assert.equal(livingBrainConfigured(), false);
  if (previous !== undefined) process.env.LIVING_BRAIN_API_KEY = previous;

  const store = new RelayStore();
  const ada = fakeSocket();
  const bob = fakeSocket();
  const adaId = "conn_nokeyaaaa" as ConnectId;
  const bobId = "conn_nokeybbbb" as ConnectId;
  store.add(ada.ws);
  store.add(bob.ws);
  store.handle(ada.ws, JSON.stringify({ type: "hello", identity: { id: adaId, displayName: "ada", host: "cursor" } }));
  store.handle(bob.ws, JSON.stringify({ type: "hello", identity: { id: bobId, displayName: "bob", host: "claude" } }));
  store.handle(ada.ws, JSON.stringify({ type: "next", prompt: secret, model: "grok", promptId: "p_ada" }));
  store.handle(bob.ws, JSON.stringify({ type: "next" }));
  const match = [...bob.sent].reverse().find((msg) => msg.type === "match");
  assert.equal(match?.type, "match");
  assert.equal(JSON.stringify(ada.sent).includes(secret), false);
  assert.equal(store.sessionFor(adaId)?.promptId, "p_ada");
});
