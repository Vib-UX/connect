import { isAddress, type Address, type Chain } from "viem";
import { bsc, bscTestnet } from "viem/chains";

/** USDT on BNB Smart Chain. ConnectEscrow holds player balances in this token. */
export const USDT_BNB = "0x55d398326f99059fF775485246999027B3197955" as Address;

export function evmChain(chainId: number): Chain {
  if (chainId === 56) return bsc;
  return bscTestnet;
}

/** ConnectEscrow chain. Default BSC testnet (97). Set 56 for BNB Chain. */
export function escrowChainId(): number {
  const raw = process.env.CONNECT_ESCROW_CHAIN_ID?.trim();
  if (raw === "56") return 56;
  return 97;
}

export interface TreasuryHome {
  chainId: number;
  name: string;
  selector: bigint;
  usdc: Address;
  address: Address;
  rpc: string;
}

function addressFrom(envName: string, fallback: string): Address | null {
  const raw = process.env[envName]?.trim() || fallback;
  return raw && isAddress(raw) ? raw : null;
}

/** RPCs that answer eth_getLogs for the escrow chain. */
export function rpcCandidates(chainId: number): string[] {
  const preferred =
    chainId === 56
      ? ["https://bsc-dataseed.binance.org", "https://bsc.llamarpc.com"]
      : [
          "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
          "https://bsc-testnet-rpc.publicnode.com",
        ];
  const env = process.env.BNB_RPC_URL?.trim();
  return [...new Set([...preferred, env].filter((item): item is string => Boolean(item)))];
}

/** ConnectEscrow address. CONNECT_ESCROW_ADDRESS overrides. */
export function escrowAddress(): Address | null {
  return addressFrom("CONNECT_ESCROW_ADDRESS", "");
}

/** Testnet MockUSDT or mainnet USDT. CONNECT_USDT_ADDRESS overrides. */
export function escrowUsdtAddress(): Address | null {
  const override = addressFrom("CONNECT_USDT_ADDRESS", "");
  if (override) return override;
  if (escrowChainId() === 56) return USDT_BNB;
  return null;
}

/** Legacy treasury lookup. Connect deposits go to the escrow, so this stays empty. */
export function treasuryHome(_chainId: number): TreasuryHome | null {
  return null;
}

export function treasuryHomes(): TreasuryHome[] {
  return [];
}
