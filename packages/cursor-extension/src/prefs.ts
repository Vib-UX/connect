import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

export const GAME_IDS = ["chess", "flappy", "sudoku", "maths", "mate"] as const;
export type GameId = (typeof GAME_IDS)[number];

export const EVM_CHAINS = [
  { id: 97, name: "BNB testnet" },
  { id: 56, name: "BNB Chain" },
] as const;

export type EvmChainId = (typeof EVM_CHAINS)[number]["id"];

export interface ConnectPrefs {
  onboarded: boolean;
  games: GameId[];
  multiplayer: boolean;
  wallet: string;
  chainId: EvmChainId;
}

export function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function chainName(id: number): string {
  return EVM_CHAINS.find((chain) => chain.id === id)?.name ?? "BNB";
}

/** ConnectEscrow on BNB testnet. Mainnet is filled in when that contract is deployed. */
export const ESCROW_TESTNET = "0x2c77532f9b5E32D0E5f5BF2AF3B1B0b3484F3E54";
export const USDT_TESTNET = "0x27Ae80b8eE17ffbCFCf38469A018A942BC8f8Ba9";
export const USDT_BNB = "0x55d398326f99059fF775485246999027B3197955";

export function escrowAddressFor(chainId: number): string {
  return chainId === 97 ? ESCROW_TESTNET : "";
}

export function escrowTerms(chainId: number): { deposit: string; stake: string; name: string } {
  if (chainId === 56) return { deposit: "$10.00", stake: "$0.05", name: "BNB Chain" };
  return { deposit: "$0.10", stake: "$0.001", name: "BNB testnet" };
}

export function prefsFile(): string {
  return join(homedir(), ".connect", "prefs.json");
}

export class PrefsStore {
  private listeners = new Set<(prefs: ConnectPrefs) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.mirror(this.get());
  }

  get(): ConnectPrefs {
    return normalize(this.context.globalState.get<Partial<ConnectPrefs>>("connect.prefs"));
  }

  async update(next: Partial<ConnectPrefs>): Promise<ConnectPrefs> {
    const prefs = normalize({ ...this.get(), ...next, onboarded: true });
    await this.context.globalState.update("connect.prefs", prefs);
    this.mirror(prefs);
    for (const fn of this.listeners) fn(prefs);
    return prefs;
  }

  private mirror(prefs: ConnectPrefs) {
    const dir = join(homedir(), ".connect");
    mkdirSync(dir, { recursive: true });
    writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  }

  onChange(fn: (prefs: ConnectPrefs) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

function normalize(raw: Partial<ConnectPrefs> | undefined): ConnectPrefs {
  const incoming = (raw?.games ?? ["chess"]) as readonly string[];
  const picked = incoming
    .map((game) => (game === "snakes" ? "flappy" : game))
    .filter((game): game is GameId => (GAME_IDS as readonly string[]).includes(game));
  const games = [...new Set(picked)];
  const multiplayer = raw?.multiplayer !== false;
  if (multiplayer && !games.includes("chess")) games.unshift("chess");
  if (games.length === 0) games.push("chess");
  const wallet = typeof raw?.wallet === "string" ? raw.wallet.trim() : "";
  const chainId = EVM_CHAINS.some((chain) => chain.id === raw?.chainId)
    ? (raw!.chainId as EvmChainId)
    : 97;
  const validWallet = isEvmAddress(wallet);
  return {
    onboarded: Boolean(raw?.onboarded) && validWallet,
    games,
    multiplayer,
    wallet: validWallet ? wallet : "",
    chainId,
  };
}
