import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface DepositProof {
  address: `0x${string}`;
  txHash: `0x${string}`;
  chainId: number;
}

export interface ShareDeposit {
  symbol: string;
  token: string;
  amount: bigint;
}

export interface DepositPage {
  chainId: number;
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
  escrow: "0x2c77532f9b5E32D0E5f5BF2AF3B1B0b3484F3E54",
  usdt: "0x27Ae80b8eE17ffbCFCf38469A018A942BC8f8Ba9",
  shareEscrow: "0xda4c60592E42DCC2AED553c38D1F8B517d89e3c7",
  shares: [
    { symbol: "NVDAB", token: "0x876904e7b854f17A5582524aa5028124240f0e8E", amount: 10n ** 18n },
    { symbol: "XAUt", token: "0x73888097E35C7105aE80022ae2A8beaAc1435E73", amount: 10n ** 18n },
  ],
  amount: 10_000_000_000_000_000_000n,
  label: "$10",
};

/** The signed deposit is only available where ConnectEscrow is deployed. Same page as the Cursor sidebar. */
export function depositPage(chainId: number): DepositPage | null {
  return chainId === 97 ? TESTNET : null;
}

/** Open a URL in the default browser, where MetaMask lives. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
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

/** MintableShare.mint(address,uint256). The testnet piles have a public mint. */
export function encodeMint(to: string, amount: bigint): string {
  return `0x40c10f19${word(to)}${word(amount)}`;
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
export function startDepositPage(
  page: DepositPage,
  returnTo: string,
  onProof: (proof: DepositProof) => void,
): Promise<string> {
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
        res.end(renderPage(page, token, approveData, depositData, returnTo));
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

function parseProof(body: string, chainId: number): DepositProof | null {
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

function renderPage(
  page: DepositPage,
  token: string,
  approveData: string,
  depositData: string,
  returnTo: string,
): string {
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
    returnTo,
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
        status('Deposit signed. ' + cfg.returnTo + ' ' + depositHash);
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
