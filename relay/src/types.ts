export type HostKind = "cursor" | "claude" | "web";
export type ConnectId = `conn_${string}`;

export interface ConnectIdentity {
  id: ConnectId;
  displayName: string;
  host: HostKind;
  ensName?: string;
  walletAddress?: `0x${string}`;
  chainId?: number;
  /** Same value for every socket of one person on one machine. */
  owner?: string;
}

export interface PeerInfo {
  id: ConnectId;
  displayName: string;
  host: HostKind;
  nearby: boolean;
  roomCode: string | null;
  ensName?: string;
  lastSeen: number;
  /** True when this peer has hit Next and is waiting for a match. */
  waiting?: boolean;
  owner?: string;
}

export interface PingMessage {
  id: string;
  from: ConnectId;
  fromName: string;
  to: ConnectId;
  text: string;
  at: number;
}

export type ChessColor = "w" | "b";

export type GameResult =
  | { kind: "win"; winner: ConnectId; reason: "checkmate" | "resign" | "timeout" }
  | { kind: "draw"; reason: "stalemate" | "agreement" | "timeout" };

export interface ChessState {
  matchId: string;
  roomCode: string;
  white: ConnectId;
  black: ConnectId;
  fen: string;
  turn: ChessColor;
  clocksMs: { w: number; b: number };
  lastMoveAt: number;
  status: "pending_deposit" | "active" | "finished";
  result?: GameResult;
  stakeWei?: string;
  /** VRF word that chose the colors. Absent when the match was not a CRE draw. */
  drawWord?: string;
  lockTx?: string;
  ccipMessageId?: string;
  payoutTx?: string;
}

export interface RoomInfo {
  code: string;
  members: ConnectId[];
  createdAt: number;
  matchId: string | null;
}

export interface ChallengeInfo {
  id: string;
  from: ConnectId;
  fromName: string;
  to: ConnectId;
  stakeWei: string;
  createdAt: number;
  expiresAt: number;
}

export type SnakeDir = "up" | "down" | "left" | "right";

export interface SnakePoint {
  x: number;
  y: number;
}

export interface SnakePlayer {
  id: ConnectId;
  name: string;
  color: string;
  body: SnakePoint[];
  dir: SnakeDir;
  pendingDir: SnakeDir;
  alive: boolean;
  connected: boolean;
  score: number;
  boost: boolean;
  deadAt: number | null;
}

export interface SnakePellet {
  id: number;
  x: number;
  y: number;
  value: number;
}

export interface SnakeResult {
  kind: "win" | "draw";
  winner?: ConnectId;
  reason: "score" | "last";
  scores: { id: ConnectId; name: string; score: number }[];
}

/** Realtime arena shared by everyone in a room. */
export interface SnakeState {
  matchId: string;
  roomCode: string;
  width: number;
  height: number;
  tick: number;
  pelletSeq: number;
  players: SnakePlayer[];
  pellets: SnakePellet[];
  status: "waiting" | "active" | "finished";
  startedAt: number | null;
  endsAt: number | null;
  result?: SnakeResult;
}

export type ClientMessage =
  | { type: "hello"; identity: ConnectIdentity }
  | { type: "heartbeat" }
  | { type: "create_room" }
  | { type: "join_room"; code: string }
  | { type: "leave_room" }
  | { type: "ping"; to: ConnectId; text: string }
  | { type: "challenge"; to: ConnectId; stakeWei?: string }
  | { type: "respond_challenge"; challengeId: string; accept: boolean }
  | { type: "move"; matchId: string; uci: string }
  | { type: "resign"; matchId: string }
  | { type: "next" }
  | { type: "poll" }
  | { type: "set_match_meta"; matchId: string; lockTx?: string; ccipMessageId?: string; payoutTx?: string; status?: ChessState["status"] }
  | { type: "claim_reward"; amount: string }
  | { type: "sync_deposit" }
  | { type: "claim_balance" }
  | { type: "snake_join"; code?: string }
  | { type: "snake_steer"; matchId: string; dir: SnakeDir; boost?: boolean }
  | { type: "snake_leave" }
  | { type: "flappy_join" }
  | { type: "flappy_score"; contestId: string; score: number }
  | { type: "rematch"; game: "chess" | "flappy" };

export interface RematchOffer {
  game: "chess" | "flappy";
  from: ConnectId;
  fromName: string;
  to: ConnectId;
  /** True for the player who asked and is waiting for the other. */
  waiting: boolean;
}

export interface FlappyView {
  id: string;
  seed: number;
  status: "waiting" | "playing" | "done";
  seeking: boolean;
  you: number | null;
  them: number | null;
  themName: string | null;
  winner: "you" | "them" | "draw" | null;
  /** Shown after the round. $0.05 from one selected chain to the other, or a deposit prompt. */
  stake?: string | null;
  /** Play balance after the round, still held until they claim. */
  balanceUsd?: string | null;
}

export interface StakeTransfer {
  id: string;
  you: "won" | "lost" | "short";
  fromChain: string;
  toChain: string;
  line: string;
  /** Explorer link for a settlement transaction. */
  href?: string | null;
}

export interface PayoutReceipt {
  txHash: string;
  chainName: string;
  usd: string;
  /** Chain explorer link for the send. */
  href: string;
  /** CCIP explorer link when that send crosses chains. */
  ccipHref?: string | null;
}

export interface BankView {
  depositUsd: string;
  stakeUsd: string;
  balanceUsd: string;
  balance: string;
  address: string;
  depositChain: string;
  canClaim: boolean;
  canPlay: boolean;
  claimLabel: string;
  transfer: StakeTransfer | null;
  /** Settlement results, newest first. Each row is one match and its transaction. */
  ledger: StakeTransfer[];
  /** Last claim. The client shows this link under the chess board. */
  payout: PayoutReceipt | null;
  note: string;
}

export type ServerMessage =
  | { type: "welcome"; identity: ConnectIdentity; peers: PeerInfo[]; room: RoomInfo | null }
  | { type: "peers"; peers: PeerInfo[] }
  | { type: "room"; room: RoomInfo | null }
  | { type: "ping"; message: PingMessage }
  | { type: "challenge"; challenge: ChallengeInfo }
  | { type: "challenge_resolved"; challengeId: string; accepted: boolean; match?: ChessState }
  | { type: "match"; match: ChessState }
  | { type: "queue"; seeking: boolean; waiting: number; drawing?: boolean }
  | { type: "error"; message: string; scope?: "reward" | "bank" }
  | { type: "reward"; txHash: string; chainId: number; amount: string; chainName: string }
  | { type: "bank"; bank: BankView }
  | { type: "bank_paid"; txHash: string; chainName: string; usd: string }
  | {
      type: "poll_state";
      peers: PeerInfo[];
      room: RoomInfo | null;
      pings: PingMessage[];
      match: ChessState | null;
      challenges: ChallengeInfo[];
      snake: SnakeState | null;
      flappy: FlappyView | null;
      bank: BankView;
      rematch: RematchOffer | null;
    }
  | { type: "flappy"; flappy: FlappyView }
  | { type: "rematch"; offer: RematchOffer | null }
  | { type: "snake"; match: SnakeState };

export interface PresenceSnapshot {
  peers: PeerInfo[];
  rooms: RoomInfo[];
  recentPings: PingMessage[];
  matches: ChessState[];
  challenges: ChallengeInfo[];
  snakes: SnakeState[];
}
