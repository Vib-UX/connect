import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";
import { escrowChainId, escrowAddress, escrowUsdtAddress, rpcCandidates, shareEscrowAddress } from "./chains.js";

/** USDT on BNB Smart Chain mainnet (18 decimals). */
export const USDT_BNB = "0x55d398326f99059fF775485246999027B3197955" as const;

function unitsFromEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (raw && /^\d+$/.test(raw)) return BigInt(raw);
  return fallback;
}

/** Format USDT (18 decimals) as $X.YY or $X.YYY when sub-cent. */
export function formatUsdt(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 10n ** 18n;
  const fracPart = abs % 10n ** 18n;
  const cents = (fracPart * 100n) / 10n ** 18n;
  if (cents > 0n || fracPart === 0n) {
    return `${negative ? "-" : ""}$${whole}.${cents.toString().padStart(2, "0")}`;
  }
  const mills = (fracPart * 1000n) / 10n ** 18n;
  return `${negative ? "-" : ""}$${whole}.${mills.toString().padStart(3, "0")}`;
}

/**
 * Match stake. Testnet default 0.001 USDT; mainnet default $0.05.
 * Override with CONNECT_ESCROW_STAKE_USDT.
 */
export const STAKE_USDT = unitsFromEnv(
  "CONNECT_ESCROW_STAKE_USDT",
  escrowChainId() === 97 ? 1_000_000_000_000_000n : 50_000_000_000_000_000n,
);

/**
 * Suggested one-time deposit. Testnet default 0.1 USDT; mainnet default $10.
 * Override with CONNECT_ESCROW_DEPOSIT_USDT.
 */
export const SUGGESTED_DEPOSIT_USDT = unitsFromEnv(
  "CONNECT_ESCROW_DEPOSIT_USDT",
  escrowChainId() === 97 ? 100_000_000_000_000_000n : 10_000_000_000_000_000_000n,
);

export const DEPOSIT_USD = formatUsdt(SUGGESTED_DEPOSIT_USDT);
export const STAKE_USD = formatUsdt(STAKE_USDT);

function escrowChain() {
  return escrowChainId() === 97 ? bscTestnet : bsc;
}

export function escrowLabel(): string {
  return escrowChainId() === 97 ? "BNB testnet" : "BNB Chain";
}

export type EscrowOutcome = "a_wins" | "b_wins" | "draw";

export interface EscrowClient {
  configured(): boolean;
  balanceOf(wallet: string): Promise<bigint>;
  /** Optional sync read for the in-memory test client and the relay cache. */
  balanceOfSync?(wallet: string): bigint;
  lock(
    betId: string,
    playerA: string,
    playerB: string,
    stake: bigint,
  ): Promise<{ txHash: string }>;
  settle(betId: string, outcome: EscrowOutcome): Promise<{ txHash: string }>;
}

const ESCROW_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "betId", type: "bytes32" },
      { name: "playerA", type: "address" },
      { name: "playerB", type: "address" },
      { name: "stake", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "betId", type: "bytes32" },
      { name: "outcome", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

/** ShareEscrow keeps one balance per token. Connect stakes USDT on both sides. */
const SHARE_ESCROW_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "player", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "betId", type: "bytes32" },
      { name: "playerA", type: "address" },
      { name: "playerB", type: "address" },
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "usdStake", type: "uint256" },
    ],
    outputs: [],
  },
  ESCROW_ABI[2],
] as const;

/** ShareEscrow needs the USDT token, so it is used only when both are known. */
function shareUsdt(): Address | null {
  return shareEscrowAddress() ? escrowUsdtAddress() : null;
}

const OUTCOME_CODE: Record<EscrowOutcome, number> = {
  a_wins: 0,
  b_wins: 1,
  draw: 2,
};

/** Hash a relay match id into the bytes32 the contract expects. */
export function betIdBytes(betId: string): Hex {
  return keccak256(stringToHex(betId));
}

/** Stake from a challenge string. "0" or empty means no escrow lock. */
export function parseStake(stakeWei?: string | null): bigint {
  if (!stakeWei || stakeWei === "0") return 0n;
  if (!/^\d+$/.test(stakeWei)) return 0n;
  return BigInt(stakeWei);
}


function settlerKey(): Hex | null {
  const raw = process.env.ESCROW_SETTLER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

export function escrowConfigured(): boolean {
  return Boolean(escrowAddress() && settlerKey());
}

/** Live ShareEscrow (or legacy ConnectEscrow) client on BNB mainnet or testnet. */
export function createEscrowClient(): EscrowClient {
  return {
    configured: () => escrowConfigured(),

    async balanceOf(wallet: string): Promise<bigint> {
      const address = escrowAddress();
      if (!address) throw new Error("ConnectEscrow is not configured.");
      if (!isAddress(wallet)) throw new Error("Wallet is not an address.");
      const chainId = escrowChainId();
      const chain = escrowChain();
      let last = "request failed";
      for (const rpc of rpcCandidates(chainId)) {
        try {
          const client = createPublicClient({ chain, transport: http(rpc) });
          const usdt = shareUsdt();
          if (usdt) {
            return await client.readContract({
              address,
              abi: SHARE_ESCROW_ABI,
              functionName: "balanceOf",
              args: [wallet as Address, usdt],
            });
          }
          return await client.readContract({
            address,
            abi: ESCROW_ABI,
            functionName: "balanceOf",
            args: [wallet as Address],
          });
        } catch (err) {
          last = err instanceof Error ? err.message.split("\n")[0]?.slice(0, 180) || "request failed" : "request failed";
        }
      }
      throw new Error(`Could not read the ${escrowLabel()} balance (${last}).`);
    },

    async lock(betId, playerA, playerB, stake) {
      const usdt = shareUsdt();
      // USDT is pegged at $1 with 18 decimals, so the stake in units is the USD stake.
      if (usdt) {
        return writeEscrow("lock", [betIdBytes(betId), playerA as Address, playerB as Address, usdt, usdt, stake]);
      }
      return writeEscrow("lock", [
        betIdBytes(betId),
        playerA as Address,
        playerB as Address,
        stake,
      ]);
    },

    async settle(betId, outcome) {
      return writeEscrow("settle", [betIdBytes(betId), OUTCOME_CODE[outcome]]);
    },
  };
}

async function writeEscrow(
  fn: "lock" | "settle",
  args: readonly unknown[],
): Promise<{ txHash: string }> {
  const address = escrowAddress();
  const key = settlerKey();
  if (!address || !key) throw new Error("ConnectEscrow is not configured.");
  const account = privateKeyToAccount(key);
  const chainId = escrowChainId();
  const chain = escrowChain();
  let last = "request failed";
  for (const rpc of rpcCandidates(chainId)) {
    try {
      const transport = http(rpc);
      const publicClient = createPublicClient({ chain, transport });
      const walletClient = createWalletClient({ account, chain, transport });
      const txHash = await walletClient.writeContract({
        address,
        abi: shareUsdt() ? SHARE_ESCROW_ABI : ESCROW_ABI,
        functionName: fn,
        args: args as never,
      });
      try {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
      } catch {
        /* submitted; receipt can arrive later */
      }
      return { txHash };
    } catch (err) {
      last = err instanceof Error ? err.message.split("\n")[0]?.slice(0, 180) || "request failed" : "request failed";
    }
  }
  throw new Error(`ConnectEscrow ${fn} failed (${last}).`);
}

/** In-memory escrow for relay tests. */
export class MemoryEscrow implements EscrowClient {
  readonly balances = new Map<string, bigint>();
  readonly locked = new Map<
    string,
    { playerA: string; playerB: string; stake: bigint; status: "locked" | "settled" | "refunded" }
  >();
  locks: Array<{ betId: string; playerA: string; playerB: string; stake: bigint }> = [];
  settles: Array<{ betId: string; outcome: EscrowOutcome }> = [];

  configured(): boolean {
    return true;
  }

  credit(wallet: string, amount: bigint): void {
    const key = wallet.toLowerCase();
    this.balances.set(key, (this.balances.get(key) ?? 0n) + amount);
  }

  balanceOfSync(wallet: string): bigint {
    return this.balances.get(wallet.toLowerCase()) ?? 0n;
  }

  async balanceOf(wallet: string): Promise<bigint> {
    return this.balanceOfSync(wallet);
  }

  async lock(betId: string, playerA: string, playerB: string, stake: bigint): Promise<{ txHash: string }> {
    if (stake <= 0n) throw new Error("Stake must be positive.");
    if (this.locked.has(betId)) throw new Error("Bet exists.");
    const a = playerA.toLowerCase();
    const b = playerB.toLowerCase();
    const balA = this.balances.get(a) ?? 0n;
    const balB = this.balances.get(b) ?? 0n;
    if (balA < stake || balB < stake) throw new Error("Insufficient balance.");
    this.balances.set(a, balA - stake);
    this.balances.set(b, balB - stake);
    this.locked.set(betId, { playerA: a, playerB: b, stake, status: "locked" });
    this.locks.push({ betId, playerA: a, playerB: b, stake });
    return { txHash: `0x${"11".repeat(32)}` };
  }

  async settle(betId: string, outcome: EscrowOutcome): Promise<{ txHash: string }> {
    const bet = this.locked.get(betId);
    if (!bet || bet.status !== "locked") throw new Error("Bet is not locked.");
    bet.status = "settled";
    const pot = bet.stake * 2n;
    if (outcome === "a_wins") {
      this.balances.set(bet.playerA, (this.balances.get(bet.playerA) ?? 0n) + pot);
    } else if (outcome === "b_wins") {
      this.balances.set(bet.playerB, (this.balances.get(bet.playerB) ?? 0n) + pot);
    } else {
      this.balances.set(bet.playerA, (this.balances.get(bet.playerA) ?? 0n) + bet.stake);
      this.balances.set(bet.playerB, (this.balances.get(bet.playerB) ?? 0n) + bet.stake);
    }
    this.settles.push({ betId, outcome });
    return { txHash: `0x${"22".repeat(32)}` };
  }
}
