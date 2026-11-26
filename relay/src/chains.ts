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

/** ShareEscrow on BSC testnet. The deposit page in Claude Code and Cursor pays into this one. */
export const SHARE_ESCROW_TESTNET = "0xda4c60592E42DCC2AED553c38D1F8B517d89e3c7" as Address;
/** MockUSDT on BSC testnet. */
export const USDT_TESTNET = "0x27Ae80b8eE17ffbCFCf38469A018A942BC8f8Ba9" as Address;
/** Minted Nvidia share on BSC testnet. Quoted as NVDA. */
export const NVDAB_TESTNET = "0x876904e7b854f17A5582524aa5028124240f0e8E" as Address;
/** Minted gold share on BSC testnet. Quoted as GOLD. */
export const XAUT_TESTNET = "0x73888097E35C7105aE80022ae2A8beaAc1435E73" as Address;

/** One share the relay can lock. `symbol` is the CoinMarketCap quote name. */
export interface ShareBookEntry {
  symbol: string;
  token: Address;
}

/** ShareEscrow address. CONNECT_SHARE_ESCROW_ADDRESS overrides. No mainnet default yet. */
export function shareEscrowAddress(): Address | null {
  return addressFrom("CONNECT_SHARE_ESCROW_ADDRESS", escrowChainId() === 97 ? SHARE_ESCROW_TESTNET : "");
}

/** Escrow that holds play balances. ShareEscrow when there is one, else ConnectEscrow from CONNECT_ESCROW_ADDRESS. */
export function escrowAddress(): Address | null {
  return shareEscrowAddress() ?? addressFrom("CONNECT_ESCROW_ADDRESS", "");
}

/** Testnet MockUSDT or mainnet USDT. CONNECT_USDT_ADDRESS overrides. */
export function escrowUsdtAddress(): Address | null {
  const override = addressFrom("CONNECT_USDT_ADDRESS", "");
  if (override) return override;
  return escrowChainId() === 56 ? USDT_BNB : USDT_TESTNET;
}

/** Shares the relay may lock on the current escrow chain. Env overrides the token addresses. */
export function shareBook(): ShareBookEntry[] {
  if (escrowChainId() !== 97) return [];
  const book: ShareBookEntry[] = [];
  const nvda = addressFrom("CONNECT_NVDAB_ADDRESS", NVDAB_TESTNET);
  const gold = addressFrom("CONNECT_XAUT_ADDRESS", XAUT_TESTNET);
  if (nvda) book.push({ symbol: "NVDA", token: nvda });
  if (gold) book.push({ symbol: "GOLD", token: gold });
  return book;
}

/** Legacy treasury lookup. Connect deposits go to the escrow, so this stays empty. */
export function treasuryHome(_chainId: number): TreasuryHome | null {
  return null;
}

export function treasuryHomes(): TreasuryHome[] {
  return [];
}
