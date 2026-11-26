import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  USDT_TESTNET,
  ESCROW_TESTNET,
  SHARE_ESCROW_TESTNET,
  NVDAB_TESTNET,
  XAUT_TESTNET,
  type EvmChainId,
} from "./prefs";

export interface DepositProof {
  address: `0x${string}`;
  txHash: `0x${string}`;
  chainId: EvmChainId;
}

interface ShareDeposit {
  symbol: string;
  token: string;
  amount: bigint;
}

interface DepositPage {
  chainId: EvmChainId;
  chainName: string;
  chainHex: string;
  rpcUrl: string;
  explorer: string;
  nativeSymbol: string;
  escrow: string;
  usdt: string;
  /** ShareEscrow. Stock approve calls spend to this address, and deposit calls land here. */
  shareEscrow: string;
  shares: ShareDeposit[];
  amount: bigint;
  label: string;
}

const TESTNET: DepositPage = {
  chainId: 97,
  chainName: "BNB testnet",
  chainHex: "0x61",
  rpcUrl: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  explorer: "https://testnet.bscscan.com",
  nativeSymbol: "tBNB",
  escrow: ESCROW_TESTNET,
  usdt: USDT_TESTNET,
  shareEscrow: SHARE_ESCROW_TESTNET,
  shares: [
    { symbol: "NVDAB", token: NVDAB_TESTNET, amount: 10n ** 18n },
    { symbol: "XAUt", token: XAUT_TESTNET, amount: 10n ** 18n },
  ],
  amount: 10_000_000_000_000_000_000n,
  label: "$10",
};

/** The signed deposit is only available where ConnectEscrow is deployed. */
export function depositPage(chainId: number): DepositPage | null {
  return chainId === 97 ? TESTNET : null;
}

export function formatUsdt(units: bigint): string {
  const whole = units / 10n ** 18n;
  const frac = units % 10n ** 18n;
  const cents = (frac * 100n) / 10n ** 18n;
  if (cents > 0n || frac === 0n) return `$${whole}.${cents.toString().padStart(2, "0")}`;
  const mills = (frac * 1000n) / 10n ** 18n;
  return `$${whole}.${mills.toString().padStart(3, "0")}`;
}

/** Free USDT balance of the address that signed the deposit, in ShareEscrow. */
export async function readEscrowBalance(account: string, chainId: number): Promise<bigint> {
  const page = depositPage(chainId);
  if (!page || !/^0x[a-fA-F0-9]{40}$/.test(account)) return 0n;
  const data = `0xf7888aec${account.slice(2).toLowerCase().padStart(64, "0")}${page.usdt.slice(2).toLowerCase().padStart(64, "0")}`;
  const response = await fetch(page.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: page.shareEscrow, data }, "latest"],
    }),
  });
  const body = (await response.json()) as { result?: string };
  if (!body.result || body.result === "0x") return 0n;
  return BigInt(body.result);
}

const DEPOSIT_TOPIC = "0xf5681f9d0db1b911ac18ee83d515a1cf1051853a9eae418316a2fdf7dea427c5";
const LOG_RPCS = ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.publicnode.com"];

export interface DepositTx {
  txHash: string;
  amount: bigint;
  at: number;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "rpc");
  return body.result;
}

const LOCKED_TOPIC = "0x4181a06c44d563d67c52a8f554a8811343ad6e95f7002375e5a64722953ac828";
const SETTLED_TOPIC = "0x38e5423e861e19556d0b69713e050c486f43b067a200882ba4ec2d0990983ad0";

export interface SettlementTx {
  txHash: string;
  stake: bigint;
  result: "won" | "lost" | "draw";
  block: number;
  at: number;
}

interface LogRow {
  topics?: string[];
  data?: string;
  transactionHash?: string;
  blockNumber?: string;
}

/** Settled matches for this wallet, newest first. Read from ConnectEscrow logs, not the relay. */
export async function readSettlements(account: string, chainId: number): Promise<SettlementTx[]> {
  const page = depositPage(chainId);
  if (!page || !/^0x[a-fA-F0-9]{40}$/.test(account)) return [];
  const topic = `0x${account.slice(2).toLowerCase().padStart(64, "0")}`;
  for (const url of [...LOG_RPCS, page.rpcUrl]) {
    try {
      const tip = BigInt(String(await rpc(url, "eth_blockNumber", [])));
      const span = 40_000n;
      const ranges = [0n, 1n].map((step) => {
        const to = tip - step * span;
        const from = to > span ? to - span : 0n;
        return { address: page.escrow, fromBlock: `0x${from.toString(16)}`, toBlock: step === 0n ? "latest" : `0x${to.toString(16)}` };
      });
      const locks = new Map<string, { seat: "a" | "b"; stake: bigint }>();
      const lockLogs = await Promise.all(
        ranges.flatMap((range) => [
          rpc(url, "eth_getLogs", [{ ...range, topics: [LOCKED_TOPIC, null, topic] }]),
          rpc(url, "eth_getLogs", [{ ...range, topics: [LOCKED_TOPIC, null, null, topic] }]),
        ]),
      );
      lockLogs.forEach((logs, index) => {
        const seat = index % 2 === 0 ? "a" : "b";
        for (const log of (logs as LogRow[]) ?? []) {
          const betId = log.topics?.[1];
          if (betId && log.data && !locks.has(betId)) locks.set(betId, { seat, stake: BigInt(log.data) });
        }
      });
      const settledLogs = (
        await Promise.all(
          ranges.map((range) => rpc(url, "eth_getLogs", [{ ...range, topics: [SETTLED_TOPIC] }])),
        )
      ).flat() as LogRow[];
      const settles: SettlementTx[] = [];
      for (const log of settledLogs) {
        const betId = log.topics?.[1];
        const lock = betId ? locks.get(betId) : undefined;
        if (!lock || !log.transactionHash || !log.data || !log.blockNumber) continue;
        const outcome = Number(BigInt(log.data.slice(0, 66)));
        const result =
          outcome === 2 ? "draw" : (lock.seat === "a" && outcome === 0) || (lock.seat === "b" && outcome === 1) ? "won" : "lost";
        settles.push({
          txHash: log.transactionHash,
          stake: lock.stake,
          result,
          block: Number(BigInt(log.blockNumber)),
          at: 0,
        });
      }
      const times = new Map<number, number>();
      await Promise.all(
        [...new Set(settles.map((row) => row.block))].map(async (block) => {
          const header = (await rpc(url, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false])) as {
            timestamp?: string;
          };
          if (header?.timestamp) times.set(block, Number(BigInt(header.timestamp)) * 1000);
        }),
      );
      for (const row of settles) row.at = times.get(row.block) ?? 0;
      const seen = new Set<string>();
      return settles
        .sort((a, b) => b.block - a.block)
        .filter((row) => (seen.has(row.txHash) ? false : (seen.add(row.txHash), true)))
        .slice(0, 12);
    } catch {
      /* try the next endpoint */
    }
  }
  return [];
}

/** Newest ShareEscrow USDT deposit for this account, walking back from the chain tip. */
export async function readLatestDeposit(account: string, chainId: number): Promise<DepositTx | null> {
  const page = depositPage(chainId);
  if (!page || !/^0x[a-fA-F0-9]{40}$/.test(account)) return null;
  const topic1 = `0x${account.slice(2).toLowerCase().padStart(64, "0")}`;
  const tokenTopic = `0x${page.usdt.slice(2).toLowerCase().padStart(64, "0")}`;
  for (const url of [...LOG_RPCS, page.rpcUrl]) {
    try {
      const tip = BigInt(String(await rpc(url, "eth_blockNumber", [])));
      const span = 3000n;
      for (let step = 0n; step < 16n; step += 1n) {
        const to = tip - step * span;
        if (to <= 0n) break;
        const from = to > span ? to - span : 0n;
        const logs = (await rpc(url, "eth_getLogs", [
          {
            address: page.shareEscrow,
            topics: [DEPOSIT_TOPIC, topic1, tokenTopic],
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          },
        ])) as Array<{ transactionHash?: string; data?: string; blockNumber?: string }>;
        if (!logs?.length) continue;
        const last = logs[logs.length - 1];
        if (!last?.transactionHash || !last.data || !last.blockNumber) continue;
        const block = (await rpc(url, "eth_getBlockByNumber", [last.blockNumber, false])) as { timestamp?: string };
        const at = block?.timestamp ? Number(BigInt(block.timestamp)) * 1000 : Date.now();
        return { txHash: last.transactionHash, amount: BigInt(last.data.slice(0, 66)), at };
      }
    } catch {
      /* try the next endpoint */
    }
  }
  return null;
}

export function encodeApprove(spender: string, amount: bigint): string {
  return `0x095ea7b3${word(spender)}${word(amount)}`;
}

export function encodeDeposit(amount: bigint): string {
  return `0xb6b55f25${word(amount)}`;
}

/** ShareEscrow.deposit(address,uint256). */
export function encodeShareDeposit(token: string, amount: bigint): string {
  return `0x47e7ef24${word(token)}${word(amount)}`;
}

function word(value: string | bigint): string {
  const hex = typeof value === "bigint" ? value.toString(16) : value.toLowerCase().replace(/^0x/, "");
  return hex.padStart(64, "0");
}

let active: { close: () => void } | undefined;

/**
 * Open a localhost page where MetaMask can sign approve + deposit.
 * The sidebar webview cannot see MetaMask, so the signature happens in the browser.
 */
export function startDepositPage(page: DepositPage, onProof: (proof: DepositProof) => void): Promise<string> {
  active?.close();
  const token = randomBytes(16).toString("hex");
  const approveData = encodeApprove(page.shareEscrow, page.amount);
  const depositData = encodeShareDeposit(page.usdt, page.amount);

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.searchParams.get("token") !== token) {
        res.writeHead(404).end("not found");
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderPage(page, token, approveData, depositData));
        return;
      }
      if (req.method === "POST" && url.pathname === "/done") {
        readBody(req, res, (body) => {
          const proof = parseProof(body, page.chainId);
          if (!proof) {
            res.writeHead(400).end("bad proof");
            return;
          }
          res.writeHead(204).end();
          onProof(proof);
          setTimeout(() => server.close(), 500);
        });
        return;
      }
      res.writeHead(404).end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      active = { close: () => server.close() };
      resolve(`http://127.0.0.1:${address.port}/?token=${token}`);
    });
    server.on("error", reject);
    setTimeout(() => server.close(), 15 * 60 * 1000).unref();
  });
}

function parseProof(body: string, chainId: EvmChainId): DepositProof | null {
  let raw: { address?: string; txHash?: string; chainId?: number };
  try {
    raw = JSON.parse(body) as { address?: string; txHash?: string; chainId?: number };
  } catch {
    return null;
  }
  if (!raw.address || !/^0x[a-fA-F0-9]{40}$/.test(raw.address)) return null;
  if (!raw.txHash || !/^0x[a-fA-F0-9]{64}$/.test(raw.txHash)) return null;
  if (raw.chainId !== chainId) return null;
  return { address: raw.address as `0x${string}`, txHash: raw.txHash as `0x${string}`, chainId };
}

function readBody(req: IncomingMessage, res: ServerResponse, done: (body: string) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 4096) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
}

function renderPage(page: DepositPage, token: string, approveData: string, depositData: string): string {
  const config = JSON.stringify({
    token,
    chainId: page.chainId,
    chainHex: page.chainHex,
    chainName: page.chainName,
    rpcUrl: page.rpcUrl,
    explorer: page.explorer,
    nativeSymbol: page.nativeSymbol,
    escrow: page.escrow,
    usdt: page.usdt,
    shareEscrow: page.shareEscrow,
    shares: page.shares.map((share) => ({
      symbol: share.symbol,
      token: share.token,
      amount: share.amount.toString(),
      approveData: encodeApprove(page.shareEscrow, share.amount),
      depositData: encodeShareDeposit(share.token, share.amount),
    })),
    approveData,
    depositData,
    amount: page.amount.toString(),
    label: page.label,
  });
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Connect deposit</title>
  <style>
    body { font: 15px/1.45 -apple-system, sans-serif; background: #12151c; color: #f4f1ea; margin: 0; }
    main { max-width: 440px; margin: 48px auto; padding: 0 20px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { color: #c8c2b4; }
    ol.flow { list-style: none; margin: 8px 0 0; padding: 0; }
    ol.flow li { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-top: 1px solid #2a3140; }
    ol.flow .n { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: #1c212b; font-size: 12px; flex: none; margin-top: 1px; }
    ol.flow strong { display: block; font-size: 14px; }
    ol.flow small { display: block; color: #8d877c; font-size: 12px; word-break: break-all; margin-top: 2px; }
    ol.flow li.on .n { background: #f0b429; color: #1a1405; }
    ol.flow li.done { opacity: 0.55; }
    .kicker { margin: 16px 0 0; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: #8d877c; }
    label.opt { display: flex; gap: 10px; align-items: flex-start; margin-top: 10px; color: #c8c2b4; cursor: pointer; }
    label.opt input { margin-top: 3px; }
    label.opt strong { display: block; color: #f4f1ea; }
    label.opt small { display: block; color: #8d877c; }
    button { margin-top: 16px; width: 100%; padding: 12px; border: 0; border-radius: 10px; background: #f0b429; color: #1a1405; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: wait; }
    .err { color: #ff8b8b; }
    a { color: #8fd3ff; }
  </style>
</head>
<body>
  <main>
    <h1>Deposit</h1>
    <p>MetaMask signs each step. The account that signs is the one Connect credits.</p>
    <ol class="flow">
      <li id="step-usdt-approve"><span class="n">1</span><div><strong>Approve ${page.label} USDT</strong><small>Allowance for ShareEscrow</small></div></li>
      <li id="step-usdt-deposit"><span class="n">2</span><div><strong>Deposit ${page.label} USDT</strong><small>${page.shareEscrow}</small></div></li>
    </ol>
    <p class="kicker">Optional shares</p>
    <label class="opt"><input type="checkbox" data-share="NVDAB" /><span><strong>NVDAB</strong><small>Approve and deposit 1 share into ${page.shareEscrow}</small></span></label>
    <label class="opt"><input type="checkbox" data-share="XAUt" /><span><strong>XAUt</strong><small>Approve and deposit 1 share into ${page.shareEscrow}</small></span></label>
    <p id="status">${page.chainName}</p>
    <button id="go">Sign deposit in MetaMask</button>
  </main>
  <script>
    const cfg = ${config};
    const $ = (id) => document.getElementById(id);
    const status = (text) => { $('status').textContent = text; };
    function mark(id) {
      let state = 'done';
      document.querySelectorAll('ol.flow li').forEach((li) => {
        if (li.id === id) { li.className = 'on'; state = ''; }
        else li.className = state;
      });
    }
    let usdtDepositHash = '';
    $('go').onclick = async () => {
      const button = $('go');
      button.disabled = true;
      try {
        const ethereum = window.ethereum;
        if (!ethereum) throw new Error('Open this page in the browser where MetaMask is installed.');
        const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
        const from = accounts && accounts[0];
        if (!from) throw new Error('MetaMask did not return an account.');
        try {
          await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: cfg.chainHex }] });
        } catch (err) {
          if (!err || err.code !== 4902) throw err;
          await ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: cfg.chainHex,
              chainName: cfg.chainName,
              nativeCurrency: { name: cfg.nativeSymbol, symbol: cfg.nativeSymbol, decimals: 18 },
              rpcUrls: [cfg.rpcUrl],
              blockExplorerUrls: [cfg.explorer]
            }]
          });
        }
        const chosen = new Set(
          Array.from(document.querySelectorAll('input[data-share]:checked')).map((el) => el.getAttribute('data-share'))
        );
        document.querySelectorAll('input[data-share]').forEach((el) => { el.disabled = true; });
        let depositHash = usdtDepositHash;
        if (!depositHash) {
          const usdtAmount = BigInt(cfg.amount);
          const usdtBalance = await readUint(ethereum, cfg.usdt, '0x70a08231' + word(from));
          if (usdtBalance < usdtAmount) {
            status('Mint ' + cfg.label + ' USDT for this account…');
            mark('step-usdt-approve');
            await sendTx(ethereum, from, cfg.usdt, '0x40c10f19' + word(from) + word(usdtAmount));
          }
          status('Approve USDT for ShareEscrow…');
          mark('step-usdt-approve');
          const approveHash = await ethereum.request({
            method: 'eth_sendTransaction',
            params: [{ from, to: cfg.usdt, data: cfg.approveData }]
          });
          await waitReceipt(ethereum, approveHash);
          status('Sign the USDT deposit…');
          mark('step-usdt-deposit');
          depositHash = await ethereum.request({
            method: 'eth_sendTransaction',
            params: [{ from, to: cfg.shareEscrow, data: cfg.depositData }]
          });
          const receipt = await waitReceipt(ethereum, depositHash);
          if (!receipt.to || receipt.to.toLowerCase() !== cfg.shareEscrow.toLowerCase()) {
            throw new Error('That transaction did not call ShareEscrow.');
          }
          usdtDepositHash = depositHash;
        }
        for (const share of cfg.shares) {
          if (!chosen.has(share.symbol)) continue;
          const amount = BigInt(share.amount);
          const balance = await readUint(ethereum, share.token, '0x70a08231' + word(from));
          if (balance < amount) {
            status('Mint 1 ' + share.symbol + ' for this account…');
            await sendTx(ethereum, from, share.token, '0x40c10f19' + word(from) + word(amount));
          }
          status('Approve ' + share.symbol + ' for the share escrow…');
          await sendTx(ethereum, from, share.token, share.approveData);
          status('Deposit ' + share.symbol + ' into the share escrow…');
          await sendTx(ethereum, from, cfg.shareEscrow, share.depositData);
        }
        const response = await fetch('/done?token=' + cfg.token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: from, txHash: depositHash, chainId: cfg.chainId })
        });
        if (!response.ok && response.status !== 204) throw new Error('Connect did not accept the proof.');
        document.querySelectorAll('ol.flow li').forEach((li) => { li.className = 'done'; });
        status('Deposit signed. Return to Cursor. ' + depositHash);
        button.textContent = 'Signed';
      } catch (err) {
        status(err && err.message ? err.message : String(err));
        $('status').className = 'err';
        button.disabled = false;
        document.querySelectorAll('input[data-share]').forEach((el) => { el.disabled = false; });
      }
    };
    function word(value) {
      const hex = (typeof value === 'bigint' ? value.toString(16) : String(value).replace(/^0x/i, '')).toLowerCase();
      return hex.padStart(64, '0');
    }
    async function readUint(ethereum, to, data) {
      const result = await ethereum.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
      if (!result || result === '0x') return 0n;
      return BigInt(result);
    }
    async function sendTx(ethereum, from, to, data) {
      const hash = await ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] });
      const receipt = await waitReceipt(ethereum, hash);
      if (!receipt.to || receipt.to.toLowerCase() !== to.toLowerCase()) {
        throw new Error('That transaction did not call ' + to + '.');
      }
      return hash;
    }
    async function waitReceipt(ethereum, hash) {
      for (let i = 0; i < 40; i++) {
        const receipt = await ethereum.request({ method: 'eth_getTransactionReceipt', params: [hash] });
        if (receipt) {
          if (receipt.status !== '0x1') throw new Error('The transaction failed.');
          return receipt;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error('Timed out waiting for the transaction.');
    }
  </script>
</body>
</html>`;
}
