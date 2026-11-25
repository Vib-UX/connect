import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface DepositProof {
  address: `0x${string}`;
  txHash: `0x${string}`;
  chainId: number;
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
  const approveData = encodeApprove(page.escrow, page.amount);
  const depositData = encodeDeposit(page.amount);

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
    approveData,
    depositData,
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
    .addr { font-family: ui-monospace, monospace; font-size: 13px; word-break: break-all; background: #1c212b; border-radius: 10px; padding: 12px; }
    button { margin-top: 16px; width: 100%; padding: 12px; border: 0; border-radius: 10px; background: #f0b429; color: #1a1405; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: wait; }
    .err { color: #ff8b8b; }
    a { color: #8fd3ff; }
  </style>
</head>
<body>
  <main>
    <h1>Deposit ${page.label} USDT</h1>
    <p>MetaMask will ask you to approve USDT, then call <strong>deposit</strong> on this escrow. The account that signs is the one Connect credits.</p>
    <div class="addr" id="escrow">${page.escrow}</div>
    <p id="status">${page.chainName} · ${page.label} USDT</p>
    <button id="go">Sign deposit in MetaMask</button>
  </main>
  <script>
    const cfg = ${config};
    const $ = (id) => document.getElementById(id);
    const status = (text) => { $('status').textContent = text; };
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
        status('Approve USDT for the escrow…');
        const approveHash = await ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: cfg.usdt, data: cfg.approveData }]
        });
        await waitReceipt(ethereum, approveHash);
        status('Sign the deposit on the escrow…');
        const depositHash = await ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: cfg.escrow, data: cfg.depositData }]
        });
        const receipt = await waitReceipt(ethereum, depositHash);
        if (!receipt.to || receipt.to.toLowerCase() !== cfg.escrow.toLowerCase()) {
          throw new Error('That transaction did not call the escrow.');
        }
        const response = await fetch('/done?token=' + cfg.token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: from, txHash: depositHash, chainId: cfg.chainId })
        });
        if (!response.ok && response.status !== 204) throw new Error('Connect did not accept the proof.');
        status('Deposit signed. ' + cfg.returnTo + ' ' + depositHash);
        $('escrow').textContent = cfg.escrow;
        button.textContent = 'Signed';
      } catch (err) {
        status(err && err.message ? err.message : String(err));
        $('status').className = 'err';
        button.disabled = false;
      }
    };
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
