import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type {
  ChallengeInfo,
  ChessState,
  PeerInfo,
  PingMessage,
  RoomInfo,
  ServerMessage,
  ConnectIdentity,
  ConnectId,
  FlappyView,
  BankView,
  RematchOffer,
  SnakeDir,
  SnakeState,
  UiState,
} from "./types";

type Listener = (state: UiState, kind?: "snake") => void;

function plainName(value: string | undefined): string {
  return (value ?? "").trim();
}

function machineOwner(host: string): string {
  const dir = join(homedir(), ".connect");
  const path = join(dir, "machine.json");
  mkdirSync(dir, { recursive: true });
  let id = "";
  if (existsSync(path)) {
    try {
      id = String((JSON.parse(readFileSync(path, "utf8")) as { id?: string }).id ?? "");
    } catch {
      id = "";
    }
  }
  if (!id) {
    id = randomBytes(8).toString("hex");
    writeFileSync(path, JSON.stringify({ id }));
  }
  return `${host}:${id}`;
}

/** One row per person. Extra sockets from the same app on this machine stay hidden. */
export function visiblePeers(peers: PeerInfo[], me: ConnectIdentity): PeerInfo[] {
  const groups = new Map<string, PeerInfo>();
  for (const peer of peers) {
    if (peer.id === me.id) continue;
    if (me.owner && peer.owner === me.owner) continue;
    if (!peer.owner && peer.host === me.host) continue;
    const key = peer.owner || `host:${peer.host}`;
    const current = groups.get(key);
    if (!current || peer.lastSeen > current.lastSeen) groups.set(key, present(peer));
  }
  return [...groups.values()];
}

function present<T extends { displayName: string; ensName?: string }>(person: T): T {
  return {
    ...person,
    displayName: plainName(person.displayName) || plainName(person.ensName) || "Player",
    ensName: undefined,
  };
}

const STALE_CHAIN = /USDC|treasury|0xE2ca5C8ed8589Dc61abE1B2c2Dae309d2f86410c/i;

function visibleError(message: string | null): string | null {
  if (!message || STALE_CHAIN.test(message)) return null;
  return message;
}

export function scrubBank(view: BankView): BankView {
  const note = STALE_CHAIN.test(view.note) ? "" : view.note;
  const transfer =
    view.transfer && STALE_CHAIN.test(`${view.transfer.line} ${view.transfer.fromChain} ${view.transfer.toChain}`)
      ? null
      : view.transfer;
  const ledger = (view.ledger ?? []).filter(
    (row) => !STALE_CHAIN.test(`${row.line} ${row.fromChain} ${row.toChain}`),
  );
  const payout = view.payout && STALE_CHAIN.test(view.payout.chainName) ? null : view.payout;
  const depositChain = STALE_CHAIN.test(view.depositChain) ? "BNB testnet" : view.depositChain;
  return { ...view, note, transfer, ledger, payout, depositChain };
}

/**
 * One identity per Cursor window (extension host), not one global file.
 * Sharing a single conn_ id made two windows kick each other off the relay.
 */
function loadIdentity(displayName: string, instanceId: string): ConnectIdentity {
  const dir = join(homedir(), ".connect", "cursor-extension");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `identity-${instanceId}.json`);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ConnectIdentity;
    let changed = false;
    if (displayName && !raw.displayName.startsWith(displayName)) {
      raw.displayName = `${displayName}-${instanceId.slice(0, 4)}`;
      changed = true;
    }
    if (raw.ensName) {
      raw.ensName = undefined;
      changed = true;
    }
    const owner = machineOwner(raw.host);
    if (raw.owner !== owner) {
      raw.owner = owner;
      changed = true;
    }
    if (changed) writeFileSync(path, JSON.stringify(raw, null, 2));
    return raw;
  }
  const short = instanceId.slice(0, 4);
  const base = displayName || `cursor`;
  const identity: ConnectIdentity = {
    id: `conn_${instanceId}` as ConnectId,
    displayName: `${base}-${short}`,
    host: "cursor",
    ensName: undefined,
    owner: machineOwner("cursor"),
  };
  writeFileSync(path, JSON.stringify(identity, null, 2));
  return identity;
}

export class RelayBridge {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<Listener>();
  private bankListeners = new Set<(view: BankView) => void>();
  private intentionalClose = false;

  me: ConnectIdentity;
  connected = false;
  peers: PeerInfo[] = [];
  room: RoomInfo | null = null;
  pings: PingMessage[] = [];
  match: ChessState | null = null;
  snake: SnakeState | null = null;
  flappy: FlappyView | null = null;
  bank: BankView | null = null;
  rematch: RematchOffer | null = null;
  lastGame: "chess" | "flappy" | null = null;
  challenges: ChallengeInfo[] = [];
  error: string | null = null;
  seeking = false;
  waiting = 0;
  drawing = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;

  constructor(
    private relayUrl: string,
    displayName: string,
    instanceId: string,
  ) {
    this.me = loadIdentity(displayName, instanceId);
  }

  get state(): UiState {
    return {
      connected: this.connected,
      me: present(this.me),
      peers: visiblePeers(this.peers, this.me),
      room: this.room,
      pings: this.pings,
      match: this.match,
      snake: this.snake,
      flappy: this.flappy,
      challenges: this.challenges,
      rematch: this.rematch,
      lastGame: this.lastGame,
      error: visibleError(this.error),
      seeking: this.seeking,
      waiting: this.waiting,
      drawing: this.drawing,
    };
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  onBank(fn: (view: BankView) => void): () => void {
    this.bankListeners.add(fn);
    if (this.bank) fn(this.bank);
    return () => this.bankListeners.delete(fn);
  }

  private emit(kind?: "snake") {
    const s = this.state;
    for (const fn of this.listeners) fn(s, kind);
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN || this.connecting) return;
    this.intentionalClose = false;
    this.error = null;
    this.connecting = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(this.relayUrl);
        this.ws = ws;
        const onOpen = () => {
          cleanup();
          this.connected = true;
          this.connecting = false;
          this.send({ type: "hello", identity: this.me });
          this.startHeartbeat();
          this.emit();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          this.connecting = false;
          this.error = err.message;
          this.emit();
          reject(err);
        };
        const cleanup = () => {
          ws.off("open", onOpen);
          ws.off("error", onError);
        };
        ws.on("open", onOpen);
        ws.on("error", onError);
        ws.on("message", (data) => this.onMessage(data.toString()));
        ws.on("close", (code) => {
          this.connected = false;
          this.connecting = false;
          this.stopHeartbeat();
          this.emit();
          if (code === 4000) {
            this.intentionalClose = true;
            return;
          }
          this.scheduleReconnect();
        });
      });
    } catch (err) {
      this.connecting = false;
      this.scheduleReconnect();
      throw err;
    }
  }

  private scheduleReconnect() {
    if (this.intentionalClose || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => undefined);
    }, 2500);
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.emit();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.send({ type: "heartbeat" }), 5000);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private onMessage(raw: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        this.peers = msg.peers;
        this.room = msg.room;
        this.seeking = false;
        this.waiting = msg.peers.filter((p) => p.waiting).length;
        this.poll();
        break;
      case "peers":
        this.peers = msg.peers;
        this.waiting = msg.peers.filter((p) => p.waiting && p.id !== this.me.id).length;
        break;
      case "room":
        this.room = msg.room;
        break;
      case "ping":
        this.pings = [...this.pings.slice(-49), msg.message];
        break;
      case "challenge":
        this.challenges = [
          ...this.challenges.filter((c) => c.id !== msg.challenge.id),
          msg.challenge,
        ];
        break;
      case "challenge_resolved":
        this.challenges = this.challenges.filter((c) => c.id !== msg.challengeId);
        if (msg.match) this.match = msg.match;
        break;
      case "match":
        this.match = msg.match;
        if (msg.match.status === "finished") this.lastGame = "chess";
        if (msg.match.status !== "finished") {
          this.seeking = false;
          this.drawing = false;
          if (this.rematch?.game === "chess") this.rematch = null;
        }
        break;
      case "snake":
        this.snake = msg.match;
        this.emit("snake");
        return;
      case "flappy":
        this.flappy = msg.flappy;
        if (msg.flappy.status === "done") this.lastGame = "flappy";
        if (msg.flappy.status === "playing" && this.rematch?.game === "flappy") this.rematch = null;
        break;
      case "rematch":
        this.rematch = msg.offer;
        break;
      case "bank":
        this.bank = msg.bank;
        if (this.error === "Unknown message type") this.error = null;
        for (const fn of this.bankListeners) fn(msg.bank);
        break;
      case "bank_paid":
        if (this.pendingClaim) {
          const pending = this.pendingClaim;
          this.pendingClaim = null;
          pending.onPaid(msg.usd, msg.chainName);
        }
        break;
      case "queue":
        this.seeking = msg.seeking;
        this.waiting = msg.waiting;
        this.drawing = Boolean(msg.drawing);
        break;
      case "poll_state":
        this.peers = msg.peers;
        this.room = msg.room;
        this.pings = msg.pings;
        this.match = msg.match;
        this.snake = msg.snake ?? null;
        this.flappy = msg.flappy ?? this.flappy;
        this.challenges = msg.challenges;
        if (msg.bank) {
          this.bank = msg.bank;
          for (const fn of this.bankListeners) fn(msg.bank);
        }
        if ("rematch" in msg) this.rematch = msg.rematch ?? null;
        if (msg.match?.status === "finished") this.lastGame = this.lastGame ?? "chess";
        if (msg.flappy?.status === "done") this.lastGame = this.lastGame ?? "flappy";
        if (msg.match && msg.match.status !== "finished") this.drawing = false;
        break;
      case "error":
        if (msg.scope === "bank") {
          const pending = this.pendingClaim;
          this.pendingClaim = null;
          pending?.onError(msg.message);
          return;
        }
        this.error = visibleError(msg.message);
        if (this.pendingReward && (msg.scope === "reward" || msg.message === "Unknown message type")) {
          const pending = this.pendingReward;
          this.pendingReward = null;
          pending.onError(msg.message);
        }
        break;
      case "reward":
        if (this.pendingReward) {
          const pending = this.pendingReward;
          this.pendingReward = null;
          pending.onReward(msg.txHash, msg.chainName);
        }
        break;
    }
    this.emit();
  }

  private pendingReward: {
    onReward: (txHash: string, chainName: string) => void;
    onError: (message: string) => void;
  } | null = null;

  private pendingClaim: {
    onPaid: (usd: string, chainName: string) => void;
    onError: (message: string) => void;
  } | null = null;

  claimReward(
    amount: string,
    hooks: { onReward: (txHash: string, chainName: string) => void; onError: (message: string) => void },
  ) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      hooks.onError("Relay is disconnected");
      return;
    }
    this.pendingReward = hooks;
    this.send({ type: "claim_reward", amount });
  }

  /** Ask the relay to read this wallet's free balance in the escrow. */
  syncDeposit(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.send({ type: "sync_deposit" });
    return true;
  }

  claimBalance(hooks: { onPaid: (usd: string, chainName: string) => void; onError: (message: string) => void }) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      hooks.onError("Relay is disconnected");
      return;
    }
    this.pendingClaim = hooks;
    this.send({ type: "claim_balance" });
  }

  createRoom() {
    this.send({ type: "create_room" });
  }

  joinRoom(code: string) {
    this.send({ type: "join_room", code: code.toUpperCase().trim() });
  }

  leaveRoom() {
    this.send({ type: "leave_room" });
  }

  ping(to: ConnectId, text: string) {
    this.send({ type: "ping", to, text });
  }

  challenge(to: ConnectId, stakeWei = "0") {
    this.send({ type: "challenge", to, stakeWei });
  }

  respond(challengeId: string, accept: boolean) {
    this.send({ type: "respond_challenge", challengeId, accept });
  }

  move(matchId: string, uci: string) {
    this.send({ type: "move", matchId, uci });
  }

  resign(matchId: string) {
    this.send({ type: "resign", matchId });
  }

  /** Pair with whoever is already waiting, or wait for the next person. */
  next() {
    this.error = null;
    this.send({ type: "next" });
  }

  poll() {
    this.send({ type: "poll" });
  }

  /** Pair with whoever is waiting to fly. The relay compares the two scores. */
  flappyJoin() {
    this.error = null;
    this.send({ type: "flappy_join" });
  }

  flappyScore(contestId: string, score: number) {
    const points = Math.max(0, Math.floor(score));
    this.send({ type: "flappy_score", contestId, score: points });
  }

  /** Ask the last opponent for the same game again. The new round starts when they agree. */
  askRematch(game: "chess" | "flappy") {
    this.error = null;
    this.send({ type: "rematch", game });
  }

  /**
   * Join a snake room. A prompt that selects snakes passes OPEN, the shared room.
   * With no code, stay in the current room, or enter OPEN if there isn't one.
   */
  snakeJoin(code?: string) {
    const room = code?.trim().toUpperCase();
    const mine = this.snake?.players.find((player) => player.id === this.me.id);
    const already =
      mine?.connected && this.snake && this.snake.status !== "finished" && (!room || this.snake.roomCode === room);
    if (already) return;
    this.error = null;
    this.send(room ? { type: "snake_join", code: room } : { type: "snake_join" });
  }

  snakeSteer(dir: SnakeDir, boost = false) {
    if (!this.snake) return;
    this.send({ type: "snake_steer", matchId: this.snake.matchId, dir, boost });
  }

  snakeLeave() {
    this.send({ type: "snake_leave" });
  }

  setPlayer(wallet: `0x${string}`, chainId: number) {
    this.me.walletAddress = wallet;
    this.me.chainId = chainId;
    const path = join(homedir(), ".connect", "cursor-extension", `identity-${this.me.id.slice(5)}.json`);
    mkdirSync(join(homedir(), ".connect", "cursor-extension"), { recursive: true });
    writeFileSync(path, JSON.stringify(this.me, null, 2));
    this.send({ type: "hello", identity: this.me });
    this.emit();
  }
}
