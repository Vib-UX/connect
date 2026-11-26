import { randomBytes } from "node:crypto";
import type WebSocket from "ws";
import {
  DEPOSIT_USD as LEGACY_DEPOSIT_USD,
  PlayBank,
  STAKE_USD as LEGACY_STAKE_USD,
  STAKE_USDC,
  chainLabel,
  formatUsdc,
  ccipHref,
  payoutReceipt,
  stakeChain,
  transferLine,
  txHref,
} from "./bank.js";
import { escrowAddress, treasuryHome } from "./chains.js";
import {
  DEPOSIT_USD,
  STAKE_USD,
  STAKE_USDT,
  type EscrowClient,
  type EscrowOutcome,
  formatUsdt,
  parseStake,
  escrowLabel,
} from "./escrow.js";
import { payReward } from "./treasury.js";
import { applyMove, applyResign, checkTimeout, createMatch } from "./chess.js";
import { kickWorkflow, makePairId, whiteIsFirst } from "./draw.js";
import {
  PUBLIC_SNAKE_ROOM,
  createSnakeMatch,
  disconnectSnake,
  joinSnake,
  setSnakeHeading,
  tickSnake,
} from "./snake.js";
import type {
  ChallengeInfo,
  ChessState,
  ClientMessage,
  PeerInfo,
  PingMessage,
  PresenceSnapshot,
  RoomInfo,
  ServerMessage,
  ConnectId,
  BankView,
  FlappyView,
  PayoutReceipt,
  RematchOffer,
  ConnectIdentity,
  SnakeDir,
  SnakeState,
  StakeTransfer,
} from "./types.js";

interface Conn {
  ws: WebSocket;
  identity: ConnectIdentity | null;
  roomCode: string | null;
  lastSeen: number;
}

interface FlappySeat {
  id: ConnectId;
  name: string;
  score: number | null;
}

interface FlappyContest {
  id: string;
  seed: number;
  status: "playing" | "done";
  a: FlappySeat;
  b: FlappySeat;
  winner: ConnectId | "draw" | null;
  /** USDT units locked in ConnectEscrow. "0" means no escrow lock. */
  stake: string;
}

interface PendingDraw {
  pairId: `0x${string}`;
  first: ConnectId;
  second: ConnectId;
  roomCode: string;
  at: number;
}

interface RematchWait {
  game: "chess" | "flappy";
  from: ConnectId;
  to: ConnectId;
  at: number;
}

const DRAW_WAIT_MS = 3 * 60 * 1000;

function roomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = randomBytes(4);
  for (let i = 0; i < 4; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export type StakeSend = (input: {
  fromChainId: number;
  toChainId: number;
  wallet: string;
  amount: bigint;
}) => Promise<{ txHash: string; messageId?: string }>;

export class RelayStore {
  private readonly bank: PlayBank;
  private readonly transfers = new Map<ConnectId, StakeTransfer>();
  private readonly ledgers = new Map<ConnectId, StakeTransfer[]>();
  private readonly walletLedgers = new Map<string, StakeTransfer[]>();
  private readonly walletTransfers = new Map<string, StakeTransfer>();
  private readonly payouts = new Map<ConnectId, PayoutReceipt>();
  private readonly notes = new Map<ConnectId, string>();
  private readonly settled = new Set<string>();

  constructor(
    private readonly options?: {
      draw?: boolean;
      bank?: PlayBank;
      requireDeposit?: boolean;
      /** Submits the cross-chain stake. Absent in tests, so they never attach an old message. */
      stakeSender?: StakeSend;
      /** ConnectEscrow on BNB Chain. When configured, balances and stakes live there. */
      escrow?: EscrowClient;
    },
  ) {
    this.bank = options?.bank ?? new PlayBank();
  }

  private readonly escrowBalances = new Map<string, bigint>();

  private usesEscrow(): boolean {
    return Boolean(this.options?.escrow?.configured());
  }

  /** Stake for a match that requires a deposit. Challenge amount wins when set. */
  private playStake(challengeStake?: string): string {
    const parsed = parseStake(challengeStake);
    if (parsed > 0n) return parsed.toString();
    if (this.usesEscrow()) return STAKE_USDT.toString();
    return "0";
  }

  private conns = new Map<WebSocket, Conn>();
  private byId = new Map<ConnectId, Conn>();
  private rooms = new Map<string, RoomInfo>();
  private pings: PingMessage[] = [];
  private matches = new Map<string, ChessState>();
  private snakes = new Map<string, SnakeState>();
  private snakeByRoom = new Map<string, string>();
  /** FIFO of players that pressed Next and are waiting for a partner. */
  private queue: ConnectId[] = [];
  /** FIFO of players waiting to fly a flappy round against one other player. */
  private flappyQueue: ConnectId[] = [];
  private flappies = new Map<string, FlappyContest>();
  private flappyByPlayer = new Map<ConnectId, string>();
  private pending = new Map<`0x${string}`, PendingDraw>();
  private rematches = new Map<string, RematchWait>();
  challenges = new Map<string, ChallengeInfo>();

  add(ws: WebSocket): void {
    this.conns.set(ws, { ws, identity: null, roomCode: null, lastSeen: Date.now() });
  }

  remove(ws: WebSocket): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    if (conn.identity) {
      this.queue = this.queue.filter((id) => id !== conn.identity!.id);
      this.cancelDraw(conn.identity.id, "Your partner left before the draw.");
      this.dropSnakePlayer(conn.identity.id);
      this.abandonFlappy(conn.identity.id);
      this.dropRematch(conn.identity.id);
      this.byId.delete(conn.identity.id);
      if (conn.roomCode) this.leaveRoom(conn);
    }
    this.conns.delete(ws);
    this.broadcastPeers();
  }

  handle(ws: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.lastSeen = Date.now();

    try {
      switch (msg.type) {
        case "hello":
          this.onHello(conn, msg.identity);
          break;
        case "heartbeat":
          break;
        case "create_room":
          this.onCreateRoom(conn);
          break;
        case "join_room":
          this.onJoinRoom(conn, msg.code);
          break;
        case "leave_room":
          this.leaveRoom(conn);
          this.send(ws, { type: "room", room: null });
          this.broadcastPeers();
          break;
        case "ping":
          this.onPing(conn, msg.to, msg.text);
          break;
        case "challenge":
          this.onChallenge(conn, msg.to, msg.stakeWei ?? "0");
          break;
        case "respond_challenge":
          this.onRespond(conn, msg.challengeId, msg.accept);
          break;
        case "move":
          this.onMove(conn, msg.matchId, msg.uci);
          break;
        case "resign":
          this.onResign(conn, msg.matchId);
          break;
        case "next":
          this.onNext(conn);
          break;
        case "poll":
          this.onPoll(conn);
          break;
        case "set_match_meta":
          this.onMatchMeta(conn, msg);
          break;
        case "claim_reward":
          void this.onClaim(conn, msg.amount);
          break;
        case "sync_deposit":
          void this.onSyncDeposit(conn);
          break;
        case "claim_balance":
          void this.onClaimBalance(conn);
          break;
        case "snake_join":
          this.onSnakeJoin(conn, msg.code);
          break;
        case "snake_steer":
          this.onSnakeSteer(conn, msg.matchId, msg.dir, msg.boost ?? false);
          break;
        case "snake_leave":
          this.onSnakeLeave(conn);
          break;
        case "flappy_join":
          this.onFlappyJoin(conn);
          break;
        case "flappy_score":
          this.onFlappyScore(conn, msg.contestId, msg.score);
          break;
        case "rematch":
          this.onRematch(conn, msg.game);
          break;
        default:
          this.send(ws, { type: "error", message: "Unknown message type" });
      }
    } catch (err) {
      this.send(ws, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async onClaim(conn: Conn, amountRaw: string): Promise<void> {
    try {
      const wallet = conn.identity?.walletAddress;
      const chainId = conn.identity?.chainId;
      if (!wallet || !chainId) {
        throw new Error("Set a wallet and a mainnet chain in the lobby first");
      }
      if (!/^\d+$/.test(amountRaw)) throw new Error("Reward amount is not a USDC value");
      const paid = await payReward({ wallet, chainId, amount: BigInt(amountRaw) });
      this.send(conn.ws, { type: "reward", ...paid });
    } catch (err) {
      this.send(conn.ws, {
        type: "error",
        scope: "reward",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async onSyncDeposit(conn: Conn, quiet = false): Promise<void> {
    const id = conn.identity?.id;
    const wallet = conn.identity?.walletAddress;
    if (!id || !wallet) {
      if (!quiet) {
        this.send(conn.ws, { type: "error", scope: "bank", message: "Set a wallet in the lobby first." });
      }
      return;
    }
    if (this.usesEscrow()) {
      try {
        const units = await this.options!.escrow!.balanceOf(wallet);
        const prev = this.escrowBalances.get(wallet.toLowerCase()) ?? 0n;
        this.escrowBalances.set(wallet.toLowerCase(), units);
        if (quiet && units === prev) return;
        const address = escrowAddress() ?? "ConnectEscrow";
        this.notes.set(
          id,
          units > 0n
            ? `${escrowLabel()} balance ${formatUsdt(units)}. A match locks ${STAKE_USD}. Withdraw the rest whenever you want.`
            : `Deposit ${DEPOSIT_USD} USDT on ${escrowLabel()} to ${address}.`,
        );
        this.sendBank(conn);
      } catch (err) {
        if (quiet) return;
        this.notes.set(id, err instanceof Error ? err.message : `Could not read the ${escrowLabel()} balance.`);
        this.sendBank(conn);
      }
      return;
    }
    try {
      const chainId = stakeChain(conn.identity);
      const found = await this.bank.pull(wallet, chainId);
      if (quiet && found.added === 0) return;
      const units = this.bank.balanceOf(wallet, chainId);
      const where = found.chains.join(" and ") || treasuryHome(chainId)?.name || chainLabel(chainId);
      this.notes.set(
        id,
        found.added > 0
          ? `Deposit added on ${where}. Balance ${formatUsdc(units)}. A loss takes ${LEGACY_STAKE_USD}. Claim the rest whenever you want.`
          : `No deposit yet. Deposit USDT on ${where} into the Connect escrow.`,
      );
      this.sendBank(conn);
    } catch (err) {
      if (quiet) return;
      this.notes.set(id, err instanceof Error ? err.message : "Could not read the deposit.");
      this.sendBank(conn);
    }
  }

  private async onClaimBalance(conn: Conn): Promise<void> {
    const id = conn.identity?.id;
    const wallet = conn.identity?.walletAddress;
    const chainId = stakeChain(conn.identity);
    if (!id || !wallet || !chainId) {
      this.send(conn.ws, {
        type: "error",
        scope: "bank",
        message: "Set a wallet and a mainnet chain in the lobby first.",
      });
      return;
    }
    let reserved = 0n;
    try {
      reserved = this.bank.reserveClaim(wallet, chainId);
      if (reserved <= 0n) throw new Error("Nothing to claim yet.");
      const paid = await payReward({ wallet, chainId, amount: reserved });
      this.bank.finishClaim(wallet, chainId);
      const usd = formatUsdc(reserved);
      const tx = `${paid.txHash.slice(0, 6)}…${paid.txHash.slice(-4)}`;
      const receipt = payoutReceipt(paid, usd);
      if (receipt) this.payouts.set(id, receipt);
      this.notes.set(id, `${usd} USDC on ${paid.chainName}. ${tx}`);
      this.sendBank(conn);
      this.send(conn.ws, { type: "bank_paid", txHash: paid.txHash, chainName: paid.chainName, usd });
    } catch (err) {
      if (reserved > 0n) this.bank.restore(wallet, reserved, chainId);
      const message = err instanceof Error ? err.message : "Claim failed.";
      this.notes.set(id, message);
      this.sendBank(conn);
      this.send(conn.ws, { type: "error", scope: "bank", message });
    }
  }

  private onHello(conn: Conn, identity: ConnectIdentity): void {
    const existing = this.byId.get(identity.id);
    if (existing && existing !== conn) {
      try {
        // 4000 tells the old client it was replaced, so it does not reconnect and kick this one.
        existing.ws.close(4000, "replaced");
      } catch {
        /* ignore */
      }
      this.conns.delete(existing.ws);
    }
    conn.identity = identity;
    this.byId.set(identity.id, conn);
    this.send(conn.ws, {
      type: "welcome",
      identity,
      peers: this.peerList(),
      room: conn.roomCode ? (this.rooms.get(conn.roomCode) ?? null) : null,
    });
    this.sendBank(conn);
    if (identity.walletAddress) void this.onSyncDeposit(conn, true);
    this.broadcastPeers();
  }

  private onCreateRoom(conn: Conn): void {
    if (!conn.identity) throw new Error("Say hello first");
    if (conn.roomCode) this.leaveRoom(conn);
    let code = roomCode();
    while (this.rooms.has(code)) code = roomCode();
    const room: RoomInfo = {
      code,
      members: [conn.identity.id],
      createdAt: Date.now(),
      matchId: null,
    };
    this.rooms.set(code, room);
    conn.roomCode = code;
    this.send(conn.ws, { type: "room", room });
    this.broadcastPeers();
  }

  private onJoinRoom(conn: Conn, code: string): void {
    if (!conn.identity) throw new Error("Say hello first");
    const normalized = code.toUpperCase().trim();
    const room = this.rooms.get(normalized);
    if (!room) throw new Error(`Room ${normalized} not found`);
    if (conn.roomCode && conn.roomCode !== normalized) this.leaveRoom(conn);
    if (!room.members.includes(conn.identity.id)) {
      room.members.push(conn.identity.id);
    }
    conn.roomCode = normalized;
    this.send(conn.ws, { type: "room", room });
    for (const id of room.members) {
      const member = this.byId.get(id);
      if (member) this.send(member.ws, { type: "room", room });
    }
    this.broadcastPeers();
  }

  private leaveRoom(conn: Conn): void {
    if (!conn.roomCode || !conn.identity) return;
    this.dropSnakePlayer(conn.identity.id);
    const room = this.rooms.get(conn.roomCode);
    if (room) {
      room.members = room.members.filter((id) => id !== conn.identity!.id);
      if (room.members.length === 0) this.rooms.delete(conn.roomCode);
      else {
        for (const id of room.members) {
          const member = this.byId.get(id);
          if (member) this.send(member.ws, { type: "room", room });
        }
      }
    }
    conn.roomCode = null;
  }

  private onSnakeJoin(conn: Conn, code?: string): void {
    if (!conn.identity) throw new Error("Say hello first");
    if (code?.trim()) this.placeInRoom(conn, code);
    else if (!conn.roomCode) this.placeInRoom(conn, PUBLIC_SNAKE_ROOM);
    if (!conn.roomCode) throw new Error("Create or join a room first");
    const now = Date.now();
    let match = this.currentSnake(conn.roomCode);
    if (!match || match.status === "finished") {
      match = createSnakeMatch(conn.roomCode);
      this.snakes.set(match.matchId, match);
      this.snakeByRoom.set(conn.roomCode, match.matchId);
    }
    joinSnake(match, conn.identity.id, conn.identity.displayName, now);
    this.broadcastSnake(match);
  }

  private onSnakeSteer(conn: Conn, matchId: string, dir: SnakeDir, boost: boolean): void {
    if (!conn.identity) throw new Error("Say hello first");
    const dirs: SnakeDir[] = ["up", "down", "left", "right"];
    if (!dirs.includes(dir)) {
      throw new Error("Direction must be up, down, left, or right");
    }
    const match = this.snakes.get(matchId);
    if (!match) throw new Error("Snake match not found");
    setSnakeHeading(match, conn.identity.id, dir, boost);
  }

  private onSnakeLeave(conn: Conn): void {
    if (!conn.identity) throw new Error("Say hello first");
    this.dropSnakePlayer(conn.identity.id);
  }

  private currentSnake(roomCode: string): SnakeState | undefined {
    const id = this.snakeByRoom.get(roomCode);
    return id ? this.snakes.get(id) : undefined;
  }

  private dropSnakePlayer(id: ConnectId): void {
    for (const [matchId, match] of this.snakes) {
      if (!match.players.some((player) => player.id === id)) continue;
      const outcome = disconnectSnake(match, id, Date.now());
      if (outcome === "remove") {
        this.snakes.delete(matchId);
        if (this.snakeByRoom.get(match.roomCode) === matchId) this.snakeByRoom.delete(match.roomCode);
        const conn = this.byId.get(id);
        if (conn) this.send(conn.ws, { type: "snake", match });
        continue;
      }
      this.broadcastSnake(match);
    }
  }

  /** Step every live arena. Called on a fixed interval by the relay process. */
  tickSnakes(now = Date.now()): void {
    for (const match of this.snakes.values()) {
      if (match.status !== "active") continue;
      tickSnake(match, now);
      this.broadcastSnake(match);
    }
    const finished = [...this.snakes.values()].filter((match) => match.status === "finished");
    while (finished.length > 6) {
      const old = finished.shift();
      if (!old) break;
      this.snakes.delete(old.matchId);
      if (this.snakeByRoom.get(old.roomCode) === old.matchId) this.snakeByRoom.delete(old.roomCode);
    }
  }

  private snakeFor(conn: Conn): SnakeState | null {
    if (!conn.identity) return null;
    if (conn.roomCode) {
      const current = this.currentSnake(conn.roomCode);
      if (current) return current;
    }
    for (const match of [...this.snakes.values()].reverse()) {
      if (match.players.some((player) => player.id === conn.identity!.id)) return match;
    }
    return null;
  }

  private broadcastSnake(match: SnakeState): void {
    const raw = JSON.stringify({ type: "snake", match } satisfies ServerMessage);
    const ids = new Set<ConnectId>(match.players.map((player) => player.id));
    const room = this.rooms.get(match.roomCode);
    if (room) for (const id of room.members) ids.add(id);
    for (const id of ids) {
      const conn = this.byId.get(id);
      if (conn && conn.ws.readyState === conn.ws.OPEN) conn.ws.send(raw);
    }
  }

  private onPing(conn: Conn, to: ConnectId, text: string): void {
    if (!conn.identity) throw new Error("Say hello first");
    const target = this.byId.get(to);
    if (!target?.identity) throw new Error("Peer offline");

    const message: PingMessage = {
      id: `ping_${randomBytes(3).toString("hex")}`,
      from: conn.identity.id,
      fromName: conn.identity.displayName,
      to,
      text: text.slice(0, 280),
      at: Date.now(),
    };
    this.pings = [...this.pings.slice(-99), message];
    this.send(conn.ws, { type: "ping", message });
    this.send(target.ws, { type: "ping", message });
  }

  private onChallenge(conn: Conn, to: ConnectId, stakeWei: string): void {
    if (!conn.identity) throw new Error("Say hello first");
    this.assertDeposit(conn);
    const target = this.byId.get(to);
    if (!target?.identity) throw new Error("Peer offline");
    if (to === conn.identity.id) throw new Error("Cannot challenge yourself");

    // Lobby challenges are allowed. On accept we put both players in one room.
    const challenge: ChallengeInfo = {
      id: `chal_${randomBytes(3).toString("hex")}`,
      from: conn.identity.id,
      fromName: conn.identity.displayName,
      to,
      stakeWei: this.playStake(stakeWei),
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    this.challenges.set(challenge.id, challenge);
    this.send(conn.ws, { type: "challenge", challenge });
    this.send(target.ws, { type: "challenge", challenge });
  }

  /** Ensure both players share a room; create one if needed. */
  private ensureSharedRoom(a: Conn, b: Conn): string {
    if (a.roomCode && a.roomCode === b.roomCode) return a.roomCode;

    if (a.roomCode && !b.roomCode) {
      this.placeInRoom(b, a.roomCode);
      return a.roomCode;
    }
    if (b.roomCode && !a.roomCode) {
      this.placeInRoom(a, b.roomCode);
      return b.roomCode;
    }

    // Different rooms or neither has one — create a fresh match room.
    if (a.roomCode) this.leaveRoom(a);
    if (b.roomCode) this.leaveRoom(b);
    let code = roomCode();
    while (this.rooms.has(code)) code = roomCode();
    const room: RoomInfo = {
      code,
      members: [],
      createdAt: Date.now(),
      matchId: null,
    };
    this.rooms.set(code, room);
    this.placeInRoom(a, code);
    this.placeInRoom(b, code);
    return code;
  }

  private placeInRoom(conn: Conn, code: string): void {
    if (!conn.identity) return;
    const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!normalized) return;
    if (conn.roomCode && conn.roomCode !== normalized) this.leaveRoom(conn);
    let room = this.rooms.get(normalized);
    if (!room) {
      room = { code: normalized, members: [], createdAt: Date.now(), matchId: null };
      this.rooms.set(normalized, room);
    }
    if (!room.members.includes(conn.identity.id)) room.members.push(conn.identity.id);
    conn.roomCode = normalized;
    for (const id of room.members) {
      const member = this.byId.get(id);
      if (member) this.send(member.ws, { type: "room", room });
    }
    this.broadcastPeers();
  }

  private onRespond(conn: Conn, challengeId: string, accept: boolean): void {
    if (!conn.identity) throw new Error("Say hello first");
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new Error("Challenge not found");
    if (challenge.to !== conn.identity.id) throw new Error("Not your challenge");
    this.challenges.delete(challengeId);

    if (!accept) {
      const payload: ServerMessage = { type: "challenge_resolved", challengeId, accepted: false };
      const fromConn = this.byId.get(challenge.from);
      this.send(conn.ws, payload);
      if (fromConn) this.send(fromConn.ws, payload);
      return;
    }

    this.assertDeposit(conn);
    const fromConn = this.byId.get(challenge.from);
    if (!fromConn?.identity) throw new Error("Challenger went offline");
    this.assertDeposit(fromConn);
    const code = this.ensureSharedRoom(fromConn, conn);
    const stake = this.playStake(challenge.stakeWei);
    const match = createMatch(code, challenge.from, challenge.to, stake);
    const whiteConn = match.white === fromConn.identity.id ? fromConn : conn;
    const blackConn = match.white === fromConn.identity.id ? conn : fromConn;
    const pending = this.lockBet(match.matchId, whiteConn, blackConn, parseStake(stake));
    this.afterLock(
      pending,
      () => {
        this.matches.set(match.matchId, match);
        const room = this.rooms.get(code);
        if (room) {
          room.matchId = match.matchId;
          for (const id of room.members) {
            const member = this.byId.get(id);
            if (member) this.send(member.ws, { type: "room", room });
          }
        }
        const payload: ServerMessage = {
          type: "challenge_resolved",
          challengeId,
          accepted: true,
          match,
        };
        this.send(conn.ws, payload);
        this.send(fromConn.ws, payload);
        this.broadcastMatch(match);
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.send(conn.ws, { type: "error", message });
        this.send(fromConn.ws, { type: "error", message });
        this.send(conn.ws, { type: "challenge_resolved", challengeId, accepted: false });
        this.send(fromConn.ws, { type: "challenge_resolved", challengeId, accepted: false });
      },
    );
  }

  private onMove(conn: Conn, matchId: string, uci: string): void {
    if (!conn.identity) throw new Error("Say hello first");
    const match = this.matches.get(matchId);
    if (!match) throw new Error("Match not found");
    const next = applyMove(match, conn.identity.id, uci);
    this.commitMatch(next);
  }

  /**
   * Omegle-style pairing. The first Next waits. The next Next starts a game
   * with whoever has been waiting the longest. No room code and no accept step.
   * Next during a live game leaves that game and looks for someone else.
   */
  private onNext(conn: Conn): void {
    if (!conn.identity) throw new Error("Say hello first");
    this.dropRematch(conn.identity.id);
    this.assertDeposit(conn);
    const me = conn.identity.id;
    this.queue = this.queue.filter((id) => id !== me);
    this.cancelDraw(me, "");

    const active = this.activeMatch(conn);
    let avoid: ConnectId | null = null;
    if (active) {
      avoid = active.white === me ? active.black : active.white;
      const finished = applyResign(active, me);
      this.commitMatch(finished);
    }

    const partnerId = this.queue.find(
      (id) => id !== me && id !== avoid && this.byId.has(id),
    );
    if (partnerId) {
      this.queue = this.queue.filter((id) => id !== partnerId);
      const partner = this.byId.get(partnerId);
      if (!partner?.identity) throw new Error("Peer offline");
      const code = this.ensureSharedRoom(conn, partner);
      if (this.drawsOn()) {
        const pairId = makePairId(partnerId, me);
        this.pending.set(pairId, {
          pairId,
          first: partnerId,
          second: me,
          roomCode: code,
          at: Date.now(),
        });
        kickWorkflow({ pairId, first: partnerId, second: me });
        this.sendQueue(conn);
        this.sendQueue(partner);
        this.broadcastPeers();
        return;
      }
      const stake = this.playStake();
      const match = createMatch(code, me, partnerId, stake);
      const whiteConn = match.white === me ? conn : partner;
      const blackConn = match.white === me ? partner : conn;
      const pending = this.lockBet(match.matchId, whiteConn, blackConn, parseStake(stake));
      this.afterLock(
        pending,
        () => {
          this.matches.set(match.matchId, match);
          const room = this.rooms.get(code);
          if (room) {
            room.matchId = match.matchId;
            for (const id of room.members) {
              const member = this.byId.get(id);
              if (member) this.send(member.ws, { type: "room", room });
            }
          }
          this.broadcastMatch(match);
          this.sendQueue(conn);
          this.sendQueue(partner);
          this.broadcastPeers();
        },
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.send(conn.ws, { type: "error", message });
          this.send(partner.ws, { type: "error", message });
          this.queue.push(partnerId);
        },
      );
      return;
    }

    this.queue.push(me);
    this.sendQueue(conn);
    this.broadcastPeers();
  }

  private activeMatch(conn: Conn): ChessState | null {
    if (!conn.identity) return null;
    for (const match of this.matches.values()) {
      if (match.status === "finished") continue;
      if (match.white === conn.identity.id || match.black === conn.identity.id) return match;
    }
    return null;
  }

  private othersWaiting(me: ConnectId): number {
    return this.queue.filter((id) => id !== me).length;
  }

  private drawsOn(): boolean {
    return this.options?.draw ?? Boolean(process.env.CONNECT_MATCH_DRAW_ADDRESS?.trim());
  }

  private drawingFor(id: ConnectId): boolean {
    for (const draw of this.pending.values()) {
      if (draw.first === id || draw.second === id) return true;
    }
    return false;
  }

  private sendQueue(conn: Conn): void {
    if (!conn.identity) return;
    const drawing = this.drawingFor(conn.identity.id);
    this.send(conn.ws, {
      type: "queue",
      seeking: this.queue.includes(conn.identity.id) || drawing,
      waiting: this.othersWaiting(conn.identity.id),
      drawing,
    });
  }

  pendingPair(): `0x${string}` | null {
    const first = this.pending.values().next().value as PendingDraw | undefined;
    return first?.pairId ?? null;
  }

  /** Called when a draw word is visible for a held pair. */
  applyDraw(pairId: `0x${string}`, word: bigint): ChessState | null {
    const held = this.pending.get(pairId);
    if (!held) return null;
    this.pending.delete(pairId);
    const first = this.byId.get(held.first);
    const second = this.byId.get(held.second);
    if (!first?.identity || !second?.identity) return null;
    const stake = this.playStake();
    const match = createMatch(held.roomCode, held.first, held.second, stake, {
      whiteIsA: whiteIsFirst(word),
      word: word.toString(),
    });
    const whiteConn = match.white === held.first ? first : second;
    const blackConn = match.white === held.first ? second : first;
    let ready: ChessState | null = null;
    const pending = this.lockBet(match.matchId, whiteConn, blackConn, parseStake(stake));
    this.afterLock(
      pending,
      () => {
        this.matches.set(match.matchId, match);
        const room = this.rooms.get(held.roomCode);
        if (room) {
          room.matchId = match.matchId;
          for (const id of room.members) {
            const member = this.byId.get(id);
            if (member) this.send(member.ws, { type: "room", room });
          }
        }
        this.broadcastMatch(match);
        this.sendQueue(first);
        this.sendQueue(second);
        this.broadcastPeers();
        ready = match;
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.send(first.ws, { type: "error", message });
        this.send(second.ws, { type: "error", message });
      },
    );
    return ready;
  }

  private cancelDraw(id: ConnectId, message: string): void {
    for (const [pairId, draw] of this.pending) {
      if (draw.first !== id && draw.second !== id) continue;
      this.pending.delete(pairId);
      const otherId = draw.first === id ? draw.second : draw.first;
      const other = this.byId.get(otherId);
      if (other && message) this.send(other.ws, { type: "error", message });
      if (other && !this.queue.includes(otherId)) this.queue.push(otherId);
      if (other) this.sendQueue(other);
    }
  }

  private sweepDraws(): void {
    const now = Date.now();
    for (const [pairId, draw] of this.pending) {
      if (now - draw.at < DRAW_WAIT_MS) continue;
      this.pending.delete(pairId);
      const message = "The draw did not arrive. Press Next again.";
      for (const id of [draw.first, draw.second]) {
        const conn = this.byId.get(id);
        if (!conn) continue;
        this.send(conn.ws, { type: "error", message });
        this.sendQueue(conn);
      }
    }
  }

  private onResign(conn: Conn, matchId: string): void {
    if (!conn.identity) throw new Error("Say hello first");
    const match = this.matches.get(matchId);
    if (!match) throw new Error("Match not found");
    const next = applyResign(match, conn.identity.id);
    this.commitMatch(next);
  }

  private onMatchMeta(
    conn: Conn,
    msg: Extract<ClientMessage, { type: "set_match_meta" }>,
  ): void {
    if (!conn.identity) throw new Error("Say hello first");
    const match = this.matches.get(msg.matchId);
    if (!match) throw new Error("Match not found");
    if (conn.identity.id !== match.white && conn.identity.id !== match.black) {
      throw new Error("Not a player in this match");
    }
    const next: ChessState = {
      ...match,
      lockTx: msg.lockTx ?? match.lockTx,
      ccipMessageId: msg.ccipMessageId ?? match.ccipMessageId,
      payoutTx: msg.payoutTx ?? match.payoutTx,
      status: msg.status ?? match.status,
    };
    this.matches.set(msg.matchId, next);
    this.broadcastMatch(next);
  }

  private flappyFor(id: ConnectId): FlappyContest | null {
    const contestId = this.flappyByPlayer.get(id);
    if (!contestId) return null;
    return this.flappies.get(contestId) ?? null;
  }

  private flappyView(id: ConnectId): FlappyView | null {
    if (this.flappyQueue.includes(id)) {
      return {
        id: "",
        seed: 0,
        status: "waiting",
        seeking: true,
        you: null,
        them: null,
        themName: null,
        winner: null,
        stake: null,
      };
    }
    const contest = this.flappyFor(id);
    if (!contest) return null;
    const me = contest.a.id === id ? contest.a : contest.b;
    const them = contest.a.id === id ? contest.b : contest.a;
    let winner: FlappyView["winner"] = null;
    if (contest.status === "done") {
      winner = contest.winner === "draw" ? "draw" : contest.winner === id ? "you" : "them";
    }
    return {
      id: contest.id,
      seed: contest.seed,
      status: contest.status,
      seeking: false,
      you: me.score,
      them: them.score,
      themName: them.name,
      winner,
      stake: contest.status === "done" ? (this.transfers.get(id)?.line ?? null) : null,
      balanceUsd: contest.status === "done" ? this.balanceUsdFor(id) : null,
    };
  }

  private sendFlappy(conn: Conn): void {
    if (!conn.identity) return;
    const flappy = this.flappyView(conn.identity.id);
    if (flappy) this.send(conn.ws, { type: "flappy", flappy });
  }

  private closeFlappy(contest: FlappyContest): void {
    if (contest.a.score == null || contest.b.score == null) return;
    if (contest.status === "done") return;
    contest.status = "done";
    if (contest.a.score === contest.b.score) {
      contest.winner = "draw";
      this.settleEscrow(contest.id, contest.a.id, contest.b.id, contest.stake, "draw");
    } else {
      contest.winner = contest.a.score > contest.b.score ? contest.a.id : contest.b.id;
      const loser = contest.winner === contest.a.id ? contest.b.id : contest.a.id;
      this.moveStake(contest.winner, loser, contest.id, contest.stake, contest.a.id, contest.b.id);
    }
  }

  private onFlappyJoin(conn: Conn): void {
    if (!conn.identity) throw new Error("Say hello first");
    this.dropRematch(conn.identity.id);
    this.assertDeposit(conn);
    const me = conn.identity.id;
    const existing = this.flappyFor(me);
    if (existing && existing.status === "playing") {
      this.sendFlappy(conn);
      return;
    }
    this.flappyQueue = this.flappyQueue.filter((id) => id !== me);
    if (existing) this.flappyByPlayer.delete(me);
    const partnerId = this.flappyQueue.find((id) => id !== me && this.byId.has(id));
    if (!partnerId) {
      this.flappyQueue.push(me);
      this.sendFlappy(conn);
      return;
    }
    this.flappyQueue = this.flappyQueue.filter((id) => id !== partnerId);
    const partner = this.byId.get(partnerId);
    if (!partner?.identity) throw new Error("Peer offline");
    const stake = this.playStake();
    const contest: FlappyContest = {
      id: `flap_${randomBytes(3).toString("hex")}`,
      seed: randomBytes(4).readUInt32BE(0) || 1,
      status: "playing",
      a: { id: partnerId, name: partner.identity.displayName, score: null },
      b: { id: me, name: conn.identity.displayName, score: null },
      winner: null,
      stake,
    };
    const pending = this.lockBet(contest.id, partner, conn, parseStake(stake));
    this.afterLock(
      pending,
      () => {
        this.flappies.set(contest.id, contest);
        this.flappyByPlayer.set(partnerId, contest.id);
        this.flappyByPlayer.set(me, contest.id);
        this.sendFlappy(partner);
        this.sendFlappy(conn);
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.send(conn.ws, { type: "error", message });
        this.send(partner.ws, { type: "error", message });
        this.flappyQueue.push(partnerId);
      },
    );
  }

  private onFlappyScore(conn: Conn, contestId: string, score: number): void {
    if (!conn.identity) throw new Error("Say hello first");
    if (!Number.isInteger(score) || score < 0 || score > 9999) throw new Error("Score is not a flappy result");
    const contest = this.flappyFor(conn.identity.id);
    if (!contest || contest.id !== contestId) throw new Error("No flappy round");
    if (contest.status === "playing") {
      const seat = contest.a.id === conn.identity.id ? contest.a : contest.b;
      if (seat.score == null) seat.score = score;
      this.closeFlappy(contest);
    }
    this.sendFlappy(conn);
    const otherId = contest.a.id === conn.identity.id ? contest.b.id : contest.a.id;
    const other = this.byId.get(otherId);
    if (other) this.sendFlappy(other);
  }

  private abandonFlappy(id: ConnectId): void {
    this.flappyQueue = this.flappyQueue.filter((queued) => queued !== id);
    const contest = this.flappyFor(id);
    this.flappyByPlayer.delete(id);
    if (!contest || contest.status === "done") return;
    const seat = contest.a.id === id ? contest.a : contest.b;
    if (seat.score == null) seat.score = 0;
    this.closeFlappy(contest);
    const otherId = contest.a.id === id ? contest.b.id : contest.a.id;
    const other = this.byId.get(otherId);
    if (other) this.sendFlappy(other);
  }

  private onPoll(conn: Conn): void {
    if (!conn.identity) throw new Error("Say hello first");
    const id = conn.identity.id;
    this.sweepTimeouts();
    void this.refreshEscrowBalance(conn).then(() => {
      const match = this.matchFor(conn);
      this.send(conn.ws, {
        type: "poll_state",
        peers: this.peerList(),
        room: conn.roomCode ? (this.rooms.get(conn.roomCode) ?? null) : null,
        pings: this.pings.filter((p) => p.to === id || p.from === id),
        match,
        snake: this.snakeFor(conn),
        flappy: this.flappyView(id),
        bank: this.bankView(conn),
        rematch: this.rematchView(id),
        challenges: [...this.challenges.values()].filter((c) => c.to === id || c.from === id),
      });
      this.sendBank(conn);
    });
  }

  private async refreshEscrowBalance(conn: Conn): Promise<void> {
    if (!this.usesEscrow()) return;
    const wallet = conn.identity?.walletAddress;
    if (!wallet) return;
    try {
      const units = await this.options!.escrow!.balanceOf(wallet);
      this.escrowBalances.set(wallet.toLowerCase(), units);
    } catch {
      /* keep the last cached balance */
    }
  }

  private matchFor(conn: Conn): ChessState | null {
    if (!conn.identity) return null;
    for (const match of this.matches.values()) {
      if (match.white === conn.identity.id || match.black === conn.identity.id) {
        if (match.status !== "finished") return match;
      }
    }
    for (const match of [...this.matches.values()].reverse()) {
      if (match.white === conn.identity.id || match.black === conn.identity.id) {
        return match;
      }
    }
    return null;
  }

  /**
   * Free escrow balance must cover one match stake on BNB Chain.
   * Without the escrow configured, play stays closed.
   */
  private assertDeposit(conn: Conn): void {
    if (!this.options?.requireDeposit) return;
    const wallet = conn.identity?.walletAddress;
    if (this.usesEscrow()) {
      if (!wallet) throw new Error("Set a wallet before you play.");
      const escrow = this.options!.escrow!;
      const units = escrow.balanceOfSync?.(wallet) ?? this.escrowBalances.get(wallet.toLowerCase()) ?? 0n;
      this.escrowBalances.set(wallet.toLowerCase(), units);
      if (units < STAKE_USDT) {
        const address = escrowAddress() ?? "ConnectEscrow";
        throw new Error(`Deposit ${DEPOSIT_USD} USDT on ${escrowLabel()} to ${address} before you play.`);
      }
      return;
    }
    const chainId = stakeChain(conn.identity);
    if (!wallet || this.bank.balanceOf(wallet, chainId) < STAKE_USDC) {
      throw new Error("Deposit USDT on BNB testnet into the Connect escrow before you play.");
    }
  }

  private balanceUsdFor(id: ConnectId): string | null {
    const identity = this.byId.get(id)?.identity;
    if (!identity?.walletAddress) return null;
    if (this.usesEscrow()) {
      const cached = this.escrowBalances.get(identity.walletAddress.toLowerCase());
      return cached == null ? null : formatUsdt(cached);
    }
    return formatUsdc(this.bank.balanceOf(identity.walletAddress, stakeChain(identity)));
  }

  /** Lock both free balances into a bet. No-op when stake is zero or escrow is off. */
  private lockBet(betId: string, a: Conn, b: Conn, stake: bigint): void | Promise<void> {
    if (stake <= 0n || !this.usesEscrow()) return;
    const walletA = a.identity?.walletAddress;
    const walletB = b.identity?.walletAddress;
    if (!walletA || !walletB) throw new Error("Both players need a wallet before a staked game.");
    return this.writeLock(betId, walletA, walletB, stake);
  }

  private async writeLock(betId: string, walletA: string, walletB: string, stake: bigint): Promise<void> {
    await this.options!.escrow!.lock(betId, walletA, walletB, stake);
    for (const wallet of [walletA, walletB]) {
      const units = this.options!.escrow!.balanceOfSync?.(wallet) ?? (await this.options!.escrow!.balanceOf(wallet));
      this.escrowBalances.set(wallet.toLowerCase(), units);
      const conn = [...this.byId.values()].find(
        (c) => c.identity?.walletAddress?.toLowerCase() === wallet.toLowerCase(),
      );
      if (conn) this.sendBank(conn);
    }
  }

  /** Run `next` now, or after an escrow lock. Keeps the no-escrow path synchronous for tests. */
  private afterLock(
    pending: void | Promise<void>,
    next: () => void,
    onError?: (err: unknown) => void,
  ): void {
    if (!pending) {
      next();
      return;
    }
    void pending.then(next).catch((err) => {
      if (onError) onError(err);
      else throw err;
    });
  }

  private rematchKey(game: "chess" | "flappy", a: ConnectId, b: ConnectId): string {
    const [x, y] = [a, b].sort();
    return `${game}:${x}:${y}`;
  }

  private rematchView(id: ConnectId): RematchOffer | null {
    let found: RematchWait | null = null;
    for (const offer of this.rematches.values()) {
      if (offer.from !== id && offer.to !== id) continue;
      if (!found || offer.at > found.at) found = offer;
    }
    if (!found) return null;
    return {
      game: found.game,
      from: found.from,
      fromName: this.byId.get(found.from)?.identity?.displayName ?? "Opponent",
      to: found.to,
      waiting: found.from === id,
    };
  }

  private sendRematch(id: ConnectId, offer: RematchOffer | null): void {
    const conn = this.byId.get(id);
    if (conn) this.send(conn.ws, { type: "rematch", offer });
  }

  /** Drop a pending rematch when this player leaves, queues, or finds someone else. */
  private dropRematch(id: ConnectId): void {
    for (const [key, offer] of this.rematches) {
      if (offer.from !== id && offer.to !== id) continue;
      this.rematches.delete(key);
      const otherId = offer.from === id ? offer.to : offer.from;
      this.sendRematch(otherId, null);
    }
  }

  private sweepRematch(now = Date.now()): void {
    for (const [key, offer] of this.rematches) {
      if (now - offer.at < 2 * 60 * 1000) continue;
      this.rematches.delete(key);
      this.sendRematch(offer.from, null);
      this.sendRematch(offer.to, null);
    }
  }

  private startChess(a: Conn, b: Conn): void {
    if (!a.identity || !b.identity) throw new Error("Peer offline");
    this.assertDeposit(a);
    this.assertDeposit(b);
    this.queue = this.queue.filter((id) => id !== a.identity!.id && id !== b.identity!.id);
    const code = this.ensureSharedRoom(a, b);
    const stake = this.playStake();
    const match = createMatch(code, a.identity.id, b.identity.id, stake);
    const whiteConn = match.white === a.identity.id ? a : b;
    const blackConn = match.white === a.identity.id ? b : a;
    const pending = this.lockBet(match.matchId, whiteConn, blackConn, parseStake(stake));
    this.afterLock(pending, () => {
      this.matches.set(match.matchId, match);
      const room = this.rooms.get(code);
      if (room) {
        room.matchId = match.matchId;
        for (const id of room.members) {
          const member = this.byId.get(id);
          if (member) this.send(member.ws, { type: "room", room });
        }
      }
      this.broadcastMatch(match);
      this.sendQueue(a);
      this.sendQueue(b);
    });
  }

  private startFlappy(a: Conn, b: Conn): void {
    if (!a.identity || !b.identity) throw new Error("Peer offline");
    this.assertDeposit(a);
    this.assertDeposit(b);
    this.flappyQueue = this.flappyQueue.filter(
      (id) => id !== a.identity!.id && id !== b.identity!.id,
    );
    const stake = this.playStake();
    const contest: FlappyContest = {
      id: `flap_${randomBytes(3).toString("hex")}`,
      seed: randomBytes(4).readUInt32BE(0) || 1,
      status: "playing",
      a: { id: a.identity.id, name: a.identity.displayName, score: null },
      b: { id: b.identity.id, name: b.identity.displayName, score: null },
      winner: null,
      stake,
    };
    const pending = this.lockBet(contest.id, a, b, parseStake(stake));
    this.afterLock(pending, () => {
      this.flappies.set(contest.id, contest);
      this.flappyByPlayer.set(a.identity!.id, contest.id);
      this.flappyByPlayer.set(b.identity!.id, contest.id);
      this.sendFlappy(a);
      this.sendFlappy(b);
    });
  }

  private onRematch(conn: Conn, game: "chess" | "flappy"): void {
    if (!conn.identity) throw new Error("Say hello first");
    if (game !== "chess" && game !== "flappy") throw new Error("Rematch is chess or flappy");
    this.assertDeposit(conn);
    const me = conn.identity.id;
    const opponentId = game === "chess" ? this.chessOpponent(conn) : this.flappyOpponent(me);
    if (!opponentId) throw new Error("Finish a game before a rematch");
    const opponent = this.byId.get(opponentId);
    if (!opponent?.identity) throw new Error("Opponent left");
    if (game === "chess" && this.activeMatch(opponent)) throw new Error("They are already in a game");
    if (game === "flappy") {
      const live = this.flappyFor(opponentId);
      if (live?.status === "playing") throw new Error("They are already in a game");
    }

    if (game === "chess") {
      this.queue = this.queue.filter((id) => id !== me);
      this.cancelDraw(me, "");
      this.sendQueue(conn);
    } else {
      this.flappyQueue = this.flappyQueue.filter((id) => id !== me);
    }

    const key = this.rematchKey(game, me, opponentId);
    const waiting = this.rematches.get(key);
    if (waiting?.from === opponentId && waiting.to === me && waiting.game === game) {
      this.assertDeposit(opponent);
      this.rematches.delete(key);
      if (game === "chess") this.startChess(opponent, conn);
      else this.startFlappy(opponent, conn);
      this.sendRematch(me, null);
      this.sendRematch(opponentId, null);
      return;
    }
    if (waiting?.from === me) {
      this.sendRematch(me, this.rematchView(me));
      return;
    }
    const offer: RematchWait = { game, from: me, to: opponentId, at: Date.now() };
    this.rematches.set(key, offer);
    this.sendRematch(me, this.rematchView(me));
    this.sendRematch(opponentId, this.rematchView(opponentId));
  }

  private chessOpponent(conn: Conn): ConnectId | null {
    const match = this.matchFor(conn);
    if (!match || match.status !== "finished" || !conn.identity) return null;
    return match.white === conn.identity.id ? match.black : match.white;
  }

  private flappyOpponent(id: ConnectId): ConnectId | null {
    const contest = this.flappyFor(id);
    if (!contest || contest.status !== "done") return null;
    return contest.a.id === id ? contest.b.id : contest.a.id;
  }

  private commitMatch(match: ChessState): void {
    const prev = this.matches.get(match.matchId);
    this.matches.set(match.matchId, match);
    if (match.status === "finished" && prev?.status === "active" && match.result) {
      if (match.result.kind === "win") {
        const winner = match.result.winner;
        const loser = winner === match.white ? match.black : match.white;
        this.moveStake(winner, loser, match.matchId, match.stakeWei, match.white, match.black);
      } else if (match.result.kind === "draw") {
        this.settleEscrow(match.matchId, match.white, match.black, match.stakeWei ?? "0", "draw");
      }
    }
    this.broadcastMatch(match);
  }

  /**
   * Settle a win: ConnectEscrow when the match was locked, otherwise the legacy ledger.
   * `seatA` / `seatB` are the wallets locked as playerA / playerB on the contract.
   */
  private moveStake(
    winnerId: ConnectId,
    loserId: ConnectId,
    key: string,
    stakeRaw?: string,
    seatA?: ConnectId,
    seatB?: ConnectId,
  ): void {
    if (this.settled.has(key)) return;
    this.settled.add(key);
    const stake = parseStake(stakeRaw);
    if (this.usesEscrow() && stake > 0n && seatA && seatB) {
      const outcome: EscrowOutcome = winnerId === seatA ? "a_wins" : "b_wins";
      this.settleEscrow(key, seatA, seatB, stakeRaw ?? "0", outcome, winnerId);
      return;
    }
    const winner = this.byId.get(winnerId)?.identity;
    const loser = this.byId.get(loserId)?.identity;
    const fromId = stakeChain(loser);
    const toId = stakeChain(winner);
    const fromChain = chainLabel(fromId);
    const toChain = chainLabel(toId);
    const loserWallet = loser?.walletAddress;
    const winnerWallet = winner?.walletAddress;
    const moved = Boolean(
      loserWallet &&
        winnerWallet &&
        this.bank.take(loserWallet, winnerWallet, STAKE_USDC, fromId, toId),
    );
    const you = (id: ConnectId): StakeTransfer["you"] => {
      if (!moved) return "short";
      return id === winnerId ? "won" : "lost";
    };
    for (const id of [winnerId, loserId]) {
      this.notes.set(id, moved ? "Balance updated. Claim it whenever you want." : "");
      this.transfers.set(id, {
        id: key,
        you: you(id),
        fromChain,
        toChain,
        line: transferLine(you(id), fromChain, toChain),
        href: null,
      });
      const conn = this.byId.get(id);
      if (conn) this.sendBank(conn);
    }
    if (moved && fromId !== toId && winnerWallet) {
      void this.publishStake(key, fromId, toId, winnerWallet);
    }
  }

  /** Credit the pot on ConnectEscrow from the relay result. */
  private settleEscrow(
    key: string,
    seatA: ConnectId,
    seatB: ConnectId,
    stakeRaw: string,
    outcome: EscrowOutcome | "draw",
    winnerId?: ConnectId,
  ): void {
    if (outcome === "draw") {
      if (this.settled.has(key)) return;
      this.settled.add(key);
    }
    const stake = parseStake(stakeRaw);
    if (!this.usesEscrow() || stake <= 0n) return;
    const resolved: EscrowOutcome = outcome === "draw" ? "draw" : outcome;
    const walletA = this.byId.get(seatA)?.identity?.walletAddress;
    const walletB = this.byId.get(seatB)?.identity?.walletAddress;
    if (!walletA || !walletB) return;

    void this.options!.escrow!.settle(key, resolved)
      .then(async (paid) => {
        for (const wallet of [walletA, walletB]) {
          const units = await this.options!.escrow!.balanceOf(wallet);
          this.escrowBalances.set(wallet.toLowerCase(), units);
        }
        const chainName = escrowLabel();
        const href = txHref(chainName, paid.txHash);
        const chess = this.matches.get(key);
        if (chess) {
          chess.payoutTx = paid.txHash;
          this.broadcastMatch(chess);
        }
        for (const id of [seatA, seatB]) {
          const lineYou: StakeTransfer["you"] =
            resolved === "draw" ? "won" : id === winnerId ? "won" : "lost";
          const line =
            resolved === "draw"
              ? `Draw on ${chainName}.`
              : lineYou === "won"
                ? `Won on ${chainName}.`
                : `Lost on ${chainName}.`;
          this.rememberSettlement(id, {
            id: key,
            you: lineYou,
            fromChain: chainName,
            toChain: chainName,
            line,
            href,
          });
          this.notes.set(
            id,
            resolved === "draw"
              ? `Draw. Stake returned to your ${chainName} balance.`
              : `Balance updated on ${chainName}. Withdraw whenever you want.`,
          );
          const conn = this.byId.get(id);
          if (conn) this.sendBank(conn);
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Escrow settle failed.";
        for (const id of [seatA, seatB]) {
          this.notes.set(id, message);
          const conn = this.byId.get(id);
          if (conn) this.sendBank(conn);
        }
      });
  }

  /** Submit the stake on CCIP, then replace the pending line with this message. */
  private async publishStake(key: string, fromId: number, toId: number, wallet: string): Promise<void> {
    const sender = this.options?.stakeSender;
    const fromChain = chainLabel(fromId);
    const toChain = chainLabel(toId);
    if (!sender) return;
    try {
      const paid = await sender({ fromChainId: fromId, toChainId: toId, wallet, amount: STAKE_USDC });
      const href = ccipHref(paid.messageId) ?? txHref(fromChain, paid.txHash);
      this.rewriteStake(key, fromChain, toChain, href, "Balance updated. Claim it whenever you want.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "The cross-chain send failed.";
      this.rewriteStake(key, fromChain, toChain, null, message);
    }
  }

  private rememberSettlement(id: ConnectId, row: StakeTransfer): void {
    const prev = this.ledgers.get(id) ?? [];
    this.ledgers.set(id, [row, ...prev.filter((item) => item.id !== row.id)].slice(0, 12));
    this.transfers.set(id, row);
    const wallet = this.byId.get(id)?.identity?.walletAddress?.toLowerCase();
    if (!wallet) return;
    const shared = this.walletLedgers.get(wallet) ?? [];
    this.walletLedgers.set(wallet, [row, ...shared.filter((item) => item.id !== row.id)].slice(0, 12));
    this.walletTransfers.set(wallet, row);
    for (const conn of this.byId.values()) {
      if (conn.identity?.walletAddress?.toLowerCase() === wallet) this.sendBank(conn);
    }
  }

  private rewriteStake(key: string, fromChain: string, toChain: string, href: string | null, note: string): void {
    for (const [id, row] of this.transfers) {
      if (row.id !== key) continue;
      const next = {
        ...row,
        href,
        line: transferLine(row.you, fromChain, toChain, href),
      };
      this.transfers.set(id, next);
      const history = this.ledgers.get(id) ?? [];
      this.ledgers.set(
        id,
        history.map((item) => (item.id === key ? next : item)),
      );
      this.notes.set(id, note);
      const conn = this.byId.get(id);
      if (conn) this.sendBank(conn);
    }
  }

  private ledgerFor(id: ConnectId | undefined, wallet?: string): StakeTransfer[] {
    const rows = id ? [...(this.ledgers.get(id) ?? [])] : [];
    const shared = wallet ? this.walletLedgers.get(wallet.toLowerCase()) ?? [] : [];
    for (const row of shared) {
      if (!rows.some((item) => item.id === row.id)) rows.push(row);
    }
    return rows;
  }

  private bankView(conn: Conn): BankView {
    const wallet = conn.identity?.walletAddress;
    const id = conn.identity?.id;
    if (this.usesEscrow()) {
      const units = wallet ? (this.escrowBalances.get(wallet.toLowerCase()) ?? 0n) : 0n;
      const address = escrowAddress() ?? "";
      return {
        depositUsd: DEPOSIT_USD,
        stakeUsd: STAKE_USD,
        balanceUsd: formatUsdt(units),
        balance: units.toString(),
        address,
        depositChain: escrowLabel(),
        canClaim: units > 0n,
        canPlay: units >= STAKE_USDT,
        claimLabel: units > 0n ? `Withdraw ${formatUsdt(units)}` : "Withdraw",
        transfer: (id ? this.transfers.get(id) : undefined) ?? (wallet ? this.walletTransfers.get(wallet.toLowerCase()) : undefined) ?? null,
        ledger: this.ledgerFor(id, wallet),
        payout: id ? (this.payouts.get(id) ?? null) : null,
        note: id ? (this.notes.get(id) ?? "") : "",
      };
    }
    const chainId = stakeChain(conn.identity);
    const units = wallet ? this.bank.balanceOf(wallet, chainId) : 0n;
    const home = treasuryHome(chainId);
    return {
      depositUsd: LEGACY_DEPOSIT_USD,
      stakeUsd: LEGACY_STAKE_USD,
      balanceUsd: formatUsdc(units),
      balance: units.toString(),
      address: home?.address ?? "",
      depositChain: home?.name ?? chainLabel(chainId),
      canClaim: units > 0n,
      canPlay: units >= STAKE_USDC,
      claimLabel: units > 0n ? `Claim ${formatUsdc(units)}` : "Claim",
      transfer: id ? (this.transfers.get(id) ?? null) : null,
      ledger: id ? (this.ledgers.get(id) ?? []) : [],
      payout: id ? (this.payouts.get(id) ?? null) : null,
      note: id ? (this.notes.get(id) ?? "") : "",
    };
  }

  private sendBank(conn: Conn): void {
    if (!conn.identity) return;
    this.send(conn.ws, { type: "bank", bank: this.bankView(conn) });
  }

  private broadcastMatch(match: ChessState): void {
    const payload: ServerMessage = { type: "match", match };
    for (const id of [match.white, match.black]) {
      const c = this.byId.get(id);
      if (c) this.send(c.ws, payload);
    }
  }

  private peerList(): PeerInfo[] {
    const groups = new Map<string, Conn[]>();
    for (const conn of this.byId.values()) {
      if (!conn.identity) continue;
      const key = conn.identity.owner || conn.identity.id;
      const members = groups.get(key) ?? [];
      members.push(conn);
      groups.set(key, members);
    }
    const list: PeerInfo[] = [];
    for (const members of groups.values()) {
      const ranked = [...members].sort((a, b) => {
        const room = Number(Boolean(b.roomCode)) - Number(Boolean(a.roomCode));
        if (room) return room;
        return b.lastSeen - a.lastSeen;
      });
      const conn = ranked[0];
      if (!conn?.identity) continue;
      list.push({
        id: conn.identity.id,
        displayName: conn.identity.displayName,
        host: conn.identity.host,
        nearby: false,
        roomCode: conn.roomCode,
        ensName: conn.identity.ensName,
        lastSeen: conn.lastSeen,
        waiting: members.some((member) => member.identity && this.queue.includes(member.identity.id)),
        owner: conn.identity.owner,
      });
    }
    return list;
  }

  private broadcastPeers(): void {
    const peers = this.peerList();
    for (const conn of this.conns.values()) {
      if (!conn.identity) continue;
      this.send(conn.ws, { type: "peers", peers });
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Finish games whose clock has hit zero. Safe to call often. */
  sweepClocks(): void {
    this.sweepTimeouts();
  }

  sweepStale(maxAgeMs = 20_000): void {
    const now = Date.now();
    for (const [ws, conn] of this.conns) {
      if (now - conn.lastSeen > maxAgeMs) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        this.remove(ws);
      }
    }
    for (const [id, chal] of this.challenges) {
      if (chal.expiresAt < now) this.challenges.delete(id);
    }
    this.sweepTimeouts();
    this.sweepDraws();
    this.sweepRematch();
  }

  private sweepTimeouts(): void {
    for (const [id, match] of this.matches) {
      if (match.status !== "active") continue;
      const next = checkTimeout(match);
      if (next !== match && next.status === "finished") {
        this.commitMatch(next);
      } else if (next.clocksMs !== match.clocksMs) {
        this.matches.set(id, next);
      }
    }
  }

  snapshot(): PresenceSnapshot {
    this.sweepTimeouts();
    return {
      peers: this.peerList(),
      rooms: [...this.rooms.values()],
      recentPings: this.pings.slice(-20),
      matches: [...this.matches.values()],
      challenges: [...this.challenges.values()],
      snakes: [...this.snakes.values()],
    };
  }
}
