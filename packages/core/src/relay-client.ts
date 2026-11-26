import WebSocket from "ws";
import type {
  ChallengeInfo,
  ChessState,
  ClientMessage,
  PeerInfo,
  PingMessage,
  RoomInfo,
  ServerMessage,
  ConnectIdentity,
  FlappyView,
  BankView,
  RematchOffer,
  PairInsight,
  SnakeDir,
  SnakeState,
} from "./types.js";

export type RelayEventHandler = (msg: ServerMessage) => void;

export class RelayClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<RelayEventHandler>();
  private pending = new Map<
    string,
    { resolve: (v: ServerMessage) => void; reject: (e: Error) => void }
  >();
  private req = 0;
  private intentionalClose = false;
  private connecting: Promise<void> | null = null;

  peers: PeerInfo[] = [];
  room: RoomInfo | null = null;
  pings: PingMessage[] = [];
  match: ChessState | null = null;
  snake: SnakeState | null = null;
  flappy: FlappyView | null = null;
  bank: BankView | null = null;
  rematch: RematchOffer | null = null;
  challenges: ChallengeInfo[] = [];
  seeking = false;
  waiting = 0;
  drawing = false;
  insight: PairInsight | null = null;
  connected = false;

  constructor(
    private url: string,
    private identity: ConnectIdentity,
  ) {}

  on(handler: RelayEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.intentionalClose = false;

    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const onOpen = () => {
        cleanup();
        this.connected = true;
        this.send({ type: "hello", identity: this.identity });
        this.startHeartbeat();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
      };

      ws.on("open", onOpen);
      ws.on("error", onError);
      // Keep a listener after open: an unhandled socket error would crash the process.
      ws.on("error", () => undefined);
      ws.on("message", (data) => this.handleRaw(data.toString()));
      ws.on("close", (code) => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.stopHeartbeat();
        // 4000: another process took this identity. Reconnecting would only kick it back.
        if (code === 4000) this.intentionalClose = true;
        if (!this.intentionalClose) this.scheduleReconnect();
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, 2000);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, 5000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to relay");
    }
    this.ws.send(JSON.stringify(msg));
  }

  private handleRaw(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    this.apply(msg);
    for (const h of this.handlers) h(msg);
  }

  private apply(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        this.peers = msg.peers;
        this.room = msg.room;
        break;
      case "peers":
        this.peers = msg.peers;
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
        break;
      case "queue":
        this.seeking = msg.seeking;
        this.waiting = msg.waiting;
        this.drawing = Boolean(msg.drawing);
        this.insight = msg.insight ?? null;
        break;
      case "snake":
        this.snake = msg.match;
        break;
      case "flappy":
        this.flappy = msg.flappy;
        if (msg.flappy.insight) this.insight = msg.flappy.insight;
        break;
      case "bank":
        this.bank = msg.bank;
        break;
      case "rematch":
        this.rematch = msg.offer;
        break;
      case "poll_state":
        this.peers = msg.peers;
        this.room = msg.room;
        this.pings = msg.pings;
        this.match = msg.match;
        this.snake = msg.snake ?? null;
        this.flappy = msg.flappy ?? null;
        this.challenges = msg.challenges;
        if (msg.bank) this.bank = msg.bank;
        if ("rematch" in msg) this.rematch = msg.rematch ?? null;
        if ("insight" in msg) this.insight = msg.insight ?? null;
        break;
      default:
        break;
    }
  }

  /** Wait until the next matching message (or timeout). */
  waitFor(
    type: ServerMessage["type"],
    timeoutMs = 8000,
    predicate?: (msg: ServerMessage) => boolean,
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const key = `${type}:${++this.req}`;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        off();
        reject(new Error(`Timeout waiting for ${type}`));
      }, timeoutMs);

      const off = this.on((msg) => {
        if (msg.type === "error") {
          clearTimeout(timer);
          this.pending.delete(key);
          off();
          reject(new Error(msg.message));
          return;
        }
        if (msg.type !== type) return;
        if (predicate && !predicate(msg)) return;
        clearTimeout(timer);
        this.pending.delete(key);
        off();
        resolve(msg);
      });
      this.pending.set(key, { resolve, reject });
    });
  }

  /** Register the waiter before sending to avoid missing a fast reply. */
  async request(
    type: ServerMessage["type"],
    sendFn: () => void,
    timeoutMs = 8000,
    predicate?: (msg: ServerMessage) => boolean,
  ): Promise<ServerMessage> {
    // Ride out a relay restart instead of failing with "Not connected to relay".
    if (this.ws?.readyState !== WebSocket.OPEN) await this.connect();
    const pending = this.waitFor(type, timeoutMs, predicate);
    sendFn();
    return pending;
  }

  createRoom(): void {
    this.send({ type: "create_room" });
  }

  joinRoom(code: string): void {
    this.send({ type: "join_room", code: code.toUpperCase() });
  }

  leaveRoom(): void {
    this.send({ type: "leave_room" });
  }

  ping(to: ConnectIdentity["id"], text: string): void {
    this.send({ type: "ping", to, text });
  }

  challenge(to: ConnectIdentity["id"], stakeWei = "0"): void {
    this.send({ type: "challenge", to, stakeWei });
  }

  respondChallenge(challengeId: string, accept: boolean): void {
    this.send({ type: "respond_challenge", challengeId, accept });
  }

  move(matchId: string, uci: string): void {
    this.send({ type: "move", matchId, uci });
  }

  resign(matchId: string): void {
    this.send({ type: "resign", matchId });
  }

  poll(): void {
    this.send({ type: "poll" });
  }

  /** Wallet that receives a claim, and the mainnet chain Claim pays on. */
  setPlayer(wallet: `0x${string}`, chainId: number) {
    this.identity.walletAddress = wallet;
    this.identity.chainId = chainId;
    return this.request("welcome", () => this.send({ type: "hello", identity: this.identity }));
  }

  syncDepositAsync() {
    return this.request("bank", () => this.send({ type: "sync_deposit" }), 20000);
  }

  claimBalanceAsync() {
    return this.request("bank_paid", () => this.send({ type: "claim_balance" }), 60000);
  }

  /** Send the prompt text for Living Brain. Does not join a queue or resign a live game. */
  notePrompt(session?: { prompt?: string; model?: string; promptId?: string }): void {
    const fields = promptSession(session);
    if (!fields.prompt) return;
    this.send({ type: "prompt", prompt: fields.prompt, model: fields.model, promptId: fields.promptId });
  }

  /** Join the pairing queue. The relay replies with `queue`, and with `match` when someone is already waiting. */
  next(session?: { prompt?: string; model?: string; promptId?: string }): void {
    this.send({ type: "next", ...promptSession(session) });
  }

  nextAsync(session?: { prompt?: string; model?: string; promptId?: string }): Promise<ServerMessage> {
    return this.request("queue", () => this.next(session));
  }

  flappyJoin(session?: { prompt?: string; model?: string; promptId?: string }): void {
    this.send({ type: "flappy_join", ...promptSession(session) });
  }

  flappyJoinAsync(session?: { prompt?: string; model?: string; promptId?: string }): Promise<ServerMessage> {
    return this.request("flappy", () => this.flappyJoin(session));
  }

  flappyScore(contestId: string, score: number): void {
    this.send({ type: "flappy_score", contestId, score });
  }

  askRematch(game: "chess" | "flappy"): void {
    this.send({ type: "rematch", game });
  }

  rematchAsync(game: "chess" | "flappy"): Promise<ServerMessage> {
    return this.request("rematch", () => this.askRematch(game));
  }

  flappyScoreAsync(contestId: string, score: number): Promise<ServerMessage> {
    return this.request(
      "flappy",
      () => this.flappyScore(contestId, score),
      8000,
      (msg) => msg.type === "flappy" && msg.flappy.id === contestId && msg.flappy.you === score,
    );
  }

  snakeJoin(code?: string): void {
    this.send(code ? { type: "snake_join", code } : { type: "snake_join" });
  }

  snakeSteer(matchId: string, dir: SnakeDir, boost = false): void {
    this.send({ type: "snake_steer", matchId, dir, boost });
  }

  snakeLeave(): void {
    this.send({ type: "snake_leave" });
  }

  createRoomAsync(): Promise<ServerMessage> {
    return this.request("room", () => this.createRoom());
  }

  joinRoomAsync(code: string): Promise<ServerMessage> {
    return this.request("room", () => this.joinRoom(code));
  }

  pingAsync(to: ConnectIdentity["id"], text: string): Promise<ServerMessage> {
    return this.request("ping", () => this.ping(to, text));
  }

  challengeAsync(to: ConnectIdentity["id"], stakeWei = "0"): Promise<ServerMessage> {
    return this.request("challenge", () => this.challenge(to, stakeWei));
  }

  respondChallengeAsync(challengeId: string, accept: boolean): Promise<ServerMessage> {
    return this.request("challenge_resolved", () => this.respondChallenge(challengeId, accept));
  }

  snakeJoinAsync(code?: string): Promise<ServerMessage> {
    return this.request(
      "snake",
      () => this.snakeJoin(code),
      8000,
      (msg) => msg.type === "snake" && msg.match.players.some((player) => player.id === this.identity.id),
    );
  }

  snakeSteerAsync(matchId: string, dir: SnakeDir, boost = false): Promise<ServerMessage> {
    return this.request(
      "snake",
      () => this.snakeSteer(matchId, dir, boost),
      8000,
      (msg) => {
        if (msg.type !== "snake" || msg.match.matchId !== matchId) return false;
        const me = msg.match.players.find((player) => player.id === this.identity.id);
        return me?.pendingDir === dir && me.boost === (me.alive && boost);
      },
    );
  }

  snakeLeaveAsync(): Promise<ServerMessage> {
    return this.request(
      "snake",
      () => this.snakeLeave(),
      8000,
      (msg) => {
        if (msg.type !== "snake") return false;
        const me = msg.match.players.find((player) => player.id === this.identity.id);
        return !me || !me.connected;
      },
    );
  }

  async moveAsync(matchId: string, uci: string): Promise<ServerMessage> {
    if (this.match?.matchId !== matchId) {
      await this.waitFor(
        "match",
        8000,
        (msg) => msg.type === "match" && msg.match.matchId === matchId,
      );
    }
    const beforeFen = this.match?.fen;
    return this.request(
      "match",
      () => this.move(matchId, uci),
      8000,
      (msg) =>
        msg.type === "match" &&
        msg.match.matchId === matchId &&
        msg.match.fen !== beforeFen,
    );
  }
}

function promptSession(session?: { prompt?: string; model?: string; promptId?: string }): {
  prompt?: string;
  model?: string;
  promptId?: string;
} {
  if (!session) return {};
  const prompt = session.prompt?.replace(/\s+/g, " ").trim().slice(0, 8000);
  const model = session.model?.trim().slice(0, 80);
  const promptId = session.promptId?.trim().slice(0, 80);
  return {
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(promptId ? { promptId } : {}),
  };
}
