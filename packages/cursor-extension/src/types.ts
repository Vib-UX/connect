export type ConnectId = `conn_${string}`;

export interface ConnectIdentity {
  id: ConnectId;
  displayName: string;
  host: "cursor" | "claude";
  ensName?: string;
  walletAddress?: `0x${string}`;
  chainId?: number;
  owner?: string;
}

export interface PeerInfo {
  id: ConnectId;
  displayName: string;
  host: string;
  nearby: boolean;
  roomCode: string | null;
  ensName?: string;
  lastSeen: number;
  waiting?: boolean;
  owner?: string;
}

export interface RoomInfo {
  code: string;
  members: ConnectId[];
  createdAt: number;
  matchId: string | null;
}

export interface PingMessage {
  id: string;
  from: ConnectId;
  fromName: string;
  to: ConnectId;
  text: string;
  at: number;
}

export interface ChessState {
  matchId: string;
  roomCode: string;
  white: ConnectId;
  black: ConnectId;
  fen: string;
  turn: "w" | "b";
  clocksMs: { w: number; b: number };
  lastMoveAt: number;
  status: "pending_deposit" | "active" | "finished";
  result?: unknown;
  stakeWei?: string;
  drawWord?: string;
}

export type SnakeDir = "up" | "down" | "left" | "right";

export interface SnakeState {
  matchId: string;
  roomCode: string;
  width: number;
  height: number;
  tick: number;
  players: {
    id: ConnectId;
    name: string;
    color: string;
    body: { x: number; y: number }[];
    dir: SnakeDir;
    pendingDir: SnakeDir;
    alive: boolean;
    connected: boolean;
    score: number;
    boost: boolean;
  }[];
  pellets: { id: number; x: number; y: number; value: number }[];
  status: "waiting" | "active" | "finished";
  endsAt: number | null;
  result?: {
    kind: "win" | "draw";
    winner?: ConnectId;
    reason: string;
    scores: { id: ConnectId; name: string; score: number }[];
  };
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
  stake?: string | null;
  balanceUsd?: string | null;
}

export interface RematchOffer {
  game: "chess" | "flappy";
  from: ConnectId;
  fromName: string;
  to: ConnectId;
  waiting: boolean;
}

export interface StakeTransfer {
  id: string;
  you: "won" | "lost" | "short";
  fromChain: string;
  toChain: string;
  line: string;
  href?: string | null;
}

export interface BankView {
  depositUsd: string;
  stakeUsd: string;
  balanceUsd: string;
  balance: string;
  address: string;
  depositChain: string;
  canClaim: boolean;
  canPlay?: boolean;
  claimLabel: string;
  transfer: StakeTransfer | null;
  ledger?: StakeTransfer[];
  payout?: { txHash: string; chainName: string; usd: string; href: string; ccipHref?: string | null } | null;
  note: string;
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
      snake?: SnakeState | null;
      flappy?: FlappyView | null;
      bank?: BankView;
      rematch?: RematchOffer | null;
    }
  | { type: "snake"; match: SnakeState }
  | { type: "flappy"; flappy: FlappyView }
  | { type: "rematch"; offer: RematchOffer | null };

export interface UiState {
  connected: boolean;
  me: ConnectIdentity | null;
  peers: PeerInfo[];
  room: RoomInfo | null;
  pings: PingMessage[];
  match: ChessState | null;
  snake: SnakeState | null;
  flappy: FlappyView | null;
  challenges: ChallengeInfo[];
  rematch: RematchOffer | null;
  lastGame: "chess" | "flappy" | null;
  error: string | null;
  /** This window pressed Next and is waiting for a partner or a draw. */
  seeking: boolean;
  /** Paired, waiting for the opening draw before the board opens. */
  drawing: boolean;
  /** Other players already waiting for Next. */
  waiting: number;
}
