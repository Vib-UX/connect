import * as vscode from "vscode";
import type { Credits } from "./credits";
import type { GameId, PrefsStore } from "./prefs";
import { depositPage, formatUsdt, readEscrowBalance, readLatestDeposit, readSettlements, startDepositPage } from "./depositSigner";
import type { PromptLedger } from "./promptLedger";
import { EVM_CHAINS, GAME_IDS, escrowAddressFor, isEvmAddress } from "./prefs";
import { scrubBank, type RelayBridge } from "./relayBridge";
import type { BankView, UiState } from "./types";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "connect.sidebar";
  private view?: vscode.WebviewView;
  private unsub?: () => void;
  private unsubCredits?: () => void;
  private unsubBank?: () => void;
  private seenResult = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: RelayBridge,
    private readonly prefs: PrefsStore,
    private readonly credits: Credits,
    private readonly prompts: PromptLedger,
    private readonly openBoard: (game?: GameId) => void,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.html(webviewView.webview);

    this.unsub?.();
    this.unsub = this.bridge.onChange((state, kind) => {
      if (kind === "snake") return;
      this.postState(state);
      const chess = state.match?.status === "finished" ? state.match.matchId : "";
      const flap = state.flappy?.status === "done" ? state.flappy.id : "";
      const key = `${chess}|${flap}`;
      if ((chess || flap) && key !== this.seenResult) {
        this.seenResult = key;
        void this.publishEscrow();
      }
    });
    this.unsubCredits?.();
    this.unsubCredits = this.credits.onChange(() => this.postCredits());
    this.unsubBank?.();
    this.unsubBank = this.bridge.onBank((view) => this.postBank(view));

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "connect":
          try {
            await this.bridge.connect();
          } catch (err) {
            vscode.window.showErrorMessage(
              `Connect relay: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          break;
        case "createRoom":
          this.bridge.createRoom();
          break;
        case "joinRoom":
          this.bridge.joinRoom(String(msg.code ?? ""));
          break;
        case "leaveRoom":
          this.bridge.leaveRoom();
          break;
        case "ping":
          if (msg.to) this.bridge.ping(msg.to, String(msg.text ?? "hello"));
          break;
        case "challenge":
          if (msg.to) this.bridge.challenge(msg.to, String(msg.stakeWei ?? "0"));
          break;
        case "respond":
          this.bridge.respond(String(msg.challengeId), Boolean(msg.accept));
          break;
        case "openBoard":
          this.openBoard();
          break;
        case "playFlappy":
          this.bridge.flappyJoin();
          this.openBoard("flappy");
          break;
        case "refresh":
          this.bridge.poll();
          void this.publishEscrow();
          break;
        case "rematch":
          if (msg.game === "chess" || msg.game === "flappy") this.bridge.askRematch(msg.game);
          break;
        case "next": {
          const picked = this.prefs.get();
          if (picked.multiplayer && picked.games.includes("chess")) {
            this.bridge.next();
            this.openBoard("chess");
          } else {
            this.openBoard(picked.games[0]);
          }
          break;
        }
        case "ready":
          this.postPrefs();
          this.postBank(this.bridge.bank);
          this.postPrompts();
          void this.publishEscrow();
          break;
        case "claimBalance": {
          const prefs = this.prefs.get();
          if (!isEvmAddress(prefs.wallet) || !prefs.chainId) {
            vscode.window.showWarningMessage("Connect: set a wallet on BNB before you withdraw.");
            break;
          }
          this.bridge.setPlayer(prefs.wallet as `0x${string}`, prefs.chainId);
          this.bridge.claimBalance({
            onPaid: (usd, chainName) => {
              const where = /bnb/i.test(chainName) ? ` on ${chainName}` : "";
              vscode.window.showInformationMessage(`Connect: ${usd} USDT sent${where}.`);
            },
            onError: (message) => {
              vscode.window.showErrorMessage(`Connect: ${message}`);
            },
          });
          break;
        }
        case "syncDeposit": {
          const prefs = this.prefs.get();
          if (!isEvmAddress(prefs.wallet)) {
            vscode.window.showWarningMessage("Connect: set a wallet before checking the deposit.");
            break;
          }
          this.bridge.setPlayer(prefs.wallet as `0x${string}`, prefs.chainId);
          if (!this.bridge.syncDeposit()) {
            vscode.window.showWarningMessage("Connect: connect to the relay, then check the deposit.");
          }
          break;
        }
        case "openLink": {
          const href = String(msg.href ?? "");
          if (
            href.startsWith("https://ccip.chain.link/") ||
            href.startsWith("https://testnet.bscscan.com/") ||
            href.startsWith("https://bscscan.com/")
          ) {
            await vscode.env.openExternal(vscode.Uri.parse(href));
          }
          break;
        }
        case "metamaskDeposit": {
          const games = Array.isArray(msg.games)
            ? msg.games.filter((game: string): game is GameId =>
                (GAME_IDS as readonly string[]).includes(game),
              )
            : this.prefs.get().games;
          const chain = EVM_CHAINS.find((item) => item.id === Number(msg.chainId)) ?? EVM_CHAINS[0];
          const current = this.prefs.get();
          await this.prefs.update({
            games: games.length ? games : current.games,
            multiplayer: msg.multiplayer !== false,
            wallet: current.wallet,
            chainId: chain.id,
          });
          const page = depositPage(chain.id);
          if (!page) {
            vscode.window.showWarningMessage(
              "Connect: deposit signing is on BNB testnet. The BNB Chain escrow is not deployed yet.",
            );
            break;
          }
          try {
            const url = await startDepositPage(page, (proof) => {
              void this.acceptDeposit(proof);
            });
            await vscode.env.openExternal(vscode.Uri.parse(url));
          } catch (err) {
            vscode.window.showErrorMessage(
              `Connect: could not open MetaMask. ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          break;
        }
        case "copyDeposit": {
          const address = this.bridge.bank?.address || escrowAddressFor(this.prefs.get().chainId);
          if (!address) {
            vscode.window.showWarningMessage("Connect: the escrow address is not available yet.");
            break;
          }
          await vscode.env.clipboard.writeText(address);
          vscode.window.showInformationMessage("Connect: deposit address copied.");
          break;
        }
        case "claim": {
          const prefs = this.prefs.get();
          if (!isEvmAddress(prefs.wallet) || !prefs.chainId) {
            vscode.window.showWarningMessage("Connect: set a wallet on BNB before you claim.");
            break;
          }
          const claimed = this.credits.claim();
          this.postCredits();
          if (claimed.cents <= 0) break;
          const amount = (BigInt(claimed.cents) * 10_000n).toString();
          this.bridge.setPlayer(prefs.wallet as `0x${string}`, prefs.chainId);
          this.bridge.claimReward(amount, {
            onReward: (txHash, chainName) => {
              this.credits.markSent(claimed.cents, prefs.wallet, chainName, txHash);
              this.postCredits();
              vscode.window.showInformationMessage(`Connect: $${(claimed.cents / 100).toFixed(2)} USDT sent.`);
            },
            onError: (message) => {
              this.credits.restore(claimed.cents, message);
              this.postCredits();
              vscode.window.showErrorMessage(`Connect: ${message}`);
            },
          });
          break;
        }
        case "savePrefs": {
          const games = Array.isArray(msg.games)
            ? msg.games.filter((game: string): game is GameId =>
                (GAME_IDS as readonly string[]).includes(game),
              )
            : [];
          const wallet = String(msg.wallet ?? "").trim();
          const chain = EVM_CHAINS.find((item) => item.id === Number(msg.chainId));
          if (!isEvmAddress(wallet) || !chain) {
            this.view?.webview.postMessage({
              type: "prefsError",
              message: "Enter a 0x wallet and choose BNB testnet or BNB Chain.",
            });
            break;
          }
          await this.prefs.update({
            games,
            multiplayer: Boolean(msg.multiplayer),
            wallet,
            chainId: chain.id,
          });
          this.bridge.setPlayer(wallet as `0x${string}`, chain.id);
          this.bridge.syncDeposit();
          this.postPrefs();
          break;
        }
      }
    });

    webviewView.onDidDispose(() => {
      this.unsub?.();
      this.unsubCredits?.();
      this.unsubBank?.();
      this.unsub = undefined;
      this.unsubCredits = undefined;
      this.unsubBank = undefined;
      this.view = undefined;
    });
  }

  private async acceptDeposit(proof: { address: `0x${string}`; txHash: `0x${string}`; chainId: number }): Promise<void> {
    const current = this.prefs.get();
    await this.prefs.update({
      games: current.games,
      multiplayer: current.multiplayer,
      wallet: proof.address,
      chainId: proof.chainId as 97 | 56,
    });
    this.bridge.setPlayer(proof.address, proof.chainId);
    this.postPrefs();
    await this.publishEscrow(proof.txHash);
    const short = `${proof.address.slice(0, 6)}…${proof.address.slice(-4)}`;
    vscode.window.showInformationMessage(`Connect: ${short} verified. Balance updated.`);
  }

  private async publishEscrow(txHash?: string): Promise<void> {
    const prefs = this.prefs.get();
    if (!isEvmAddress(prefs.wallet)) return;
    let units = 0n;
    try {
      for (let attempt = 0; attempt < (txHash ? 6 : 1); attempt += 1) {
        units = await readEscrowBalance(prefs.wallet, prefs.chainId);
        if (units > 0n || !txHash) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch {
      return;
    }
    const page = depositPage(prefs.chainId);
    let found: Awaited<ReturnType<typeof readLatestDeposit>> = null;
    let settled: Awaited<ReturnType<typeof readSettlements>> = [];
    try {
      [found, settled] = await Promise.all([
        readLatestDeposit(prefs.wallet, prefs.chainId),
        readSettlements(prefs.wallet, prefs.chainId),
      ]);
    } catch {
      found = null;
    }
    const hash = found?.txHash || txHash || "";
    const when = found?.at ? new Date(found.at) : null;
    const pad = (n: number) => String(n).padStart(2, "0");
    const clock = when ? `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}` : "";
    const shortTx = hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : "";
    const deposit = hash
      ? {
          title: "Deposit",
          meta: [shortTx, page?.chainName || "BNB", clock].filter(Boolean).join(" · "),
          amount: found ? `+${formatUsdt(found.amount)}` : `+${page?.label ?? ""}`,
          href: `${page?.explorer || "https://testnet.bscscan.com"}/tx/${hash}`,
        }
      : null;
    this.view?.webview.postMessage({
      type: "escrow",
      address: prefs.wallet,
      balance: units.toString(),
      balanceUsd: formatUsdt(units),
      txHash: hash,
      deposit,
      settlements: settled.map((row) => ({
        title: row.result === "draw" ? "Draw" : row.result === "won" ? "Won" : "Lost",
        meta: "BNB testnet",
        amount: `${row.result === "lost" ? "-" : "+"}${formatUsdt(row.stake)}`,
        href: `${page?.explorer || "https://testnet.bscscan.com"}/tx/${row.txHash}`,
        at: row.at,
      })),
    });
  }

  postPrompts() {
    this.view?.webview.postMessage({ type: "prompts", rows: this.prompts.lines() });
  }

  refresh() {
    if (this.view) this.postState(this.bridge.state);
  }

  private postState(state: UiState) {
    this.view?.webview.postMessage({ type: "state", state });
  }

  private postPrefs() {
    this.view?.webview.postMessage({ type: "prefs", prefs: this.prefs.get() });
  }

  private postCredits() {
    this.view?.webview.postMessage({ type: "credits", credits: this.credits.view() });
  }

  private postBank(view: BankView | null) {
    this.view?.webview.postMessage({ type: "bank", bank: view ? scrubBank(view) : view });
  }

  private html(webview: vscode.Webview): string {
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'unsafe-inline'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    body { margin: 0; padding: 14px 12px 20px; }
    h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.65; margin: 16px 0 8px; }
    .status { display: flex; align-items: center; gap: 8px; font-size: 12px; opacity: 0.85; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; flex: none; }
    .dot.on { background: #3fb950; box-shadow: 0 0 0 3px rgba(63,185,80,0.18); }
    .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; opacity: 0.75; }
    .me { font-size: 13px; font-weight: 600; margin: 8px 0 14px; }
    .balance { font-size: 28px; font-weight: 650; letter-spacing: -0.03em; line-height: 1; }
    .bal-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; }
    .bal-sub { margin-top: 6px; font-size: 11px; opacity: 0.55; }
    .bal-actions { display: flex; gap: 6px; }
    button.ghost {
      width: auto;
      margin: 0;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 500;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-widget-border, #444);
    }
    .feed-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 0;
      border-top: 1px solid var(--vscode-widget-border, #333);
      color: inherit;
      text-decoration: none;
    }
    .feed-title { font-size: 12.5px; line-height: 1.35; }
    .feed-meta { margin-top: 3px; font-size: 11px; opacity: 0.55; }
    .feed-amt { font-variant-numeric: tabular-nums; font-size: 12.5px; font-weight: 650; white-space: nowrap; }
    .feed-meta a { color: var(--vscode-textLink-foreground); }
    .card {
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 10px;
      background: var(--vscode-editor-background);
    }
    .row { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin: 6px 0; }
    select, button, input {
      font: inherit;
      border-radius: 6px;
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 5px 8px;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.next {
      width: 100%;
      margin-top: 8px;
      padding: 8px 10px;
      font-weight: 600;
    }
    details { margin-top: 12px; }
    details summary { cursor: pointer; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; }
    select, input {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-color: var(--vscode-input-border, #555);
      margin: 4px 0 8px;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .stack { display: grid; gap: 8px; margin-top: 12px; }
    .stack button.next { margin-top: 0; }
    label.field { display: block; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.65; margin-top: 4px; }
    .err { color: var(--vscode-errorForeground); font-size: 12px; }
    .empty { opacity: 0.6; font-size: 12px; }
    .badge {
      font-size: 10px; padding: 1px 6px; border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-button-background) 30%, transparent);
    }
    .games { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 10px; margin-bottom: 8px; }
    .choice { display: flex; align-items: center; gap: 8px; margin: 4px 0; cursor: pointer; }
    .choice.wide { grid-column: 1 / -1; }
    .ledger { margin-top: 8px; }
    .ledger a {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      color: inherit;
      text-decoration: none;
      padding: 5px 0;
      border-top: 1px solid var(--vscode-widget-border, #444);
    }
    .addr { word-break: break-all; font-size: 12px; line-height: 1.4; margin: 6px 0; user-select: text; }
    #bankTransfer a { word-break: break-all; color: var(--vscode-textLink-foreground); }
    .choice input { width: auto; margin: 0; }
    ol.flow { list-style: none; margin: 10px 0 0; padding: 0; }
    ol.flow li { display: flex; gap: 8px; align-items: baseline; padding: 6px 0; border-top: 1px solid var(--vscode-widget-border, #333); font-size: 12.5px; }
    ol.flow span { opacity: 0.55; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <div class="status">
    <span class="dot" id="dot"></span>
    <span id="statusText">Disconnected</span>
  </div>
  <div id="me" class="me"></div>
  <div id="err" class="err"></div>
  <div class="card balance-card" id="balanceBlock" style="display:none">
    <div class="bal-row">
      <div>
        <div class="balance" id="bankBalance">$0.00</div>
        <div class="bal-sub" id="balSub">USDT</div>
      </div>
      <div class="bal-actions">
        <button class="ghost" id="depositMore">Deposit</button>
        <button class="ghost" id="claimBalance" disabled>Withdraw</button>
      </div>
    </div>
  </div>
  <div class="card" id="gamesCard">
    <h2 style="margin-top:0">Play</h2>
    <div class="games">
      <label class="choice"><input type="checkbox" data-game="chess" checked /> Chess</label>
      <label class="choice"><input type="checkbox" data-game="flappy" checked /> Flappy</label>
      <label class="choice"><input type="checkbox" data-game="sudoku" /> Sudoku</label>
      <label class="choice"><input type="checkbox" data-game="maths" /> Maths</label>
      <label class="choice"><input type="checkbox" data-game="mate" /> Mate in 1</label>
      <label class="choice wide"><input type="checkbox" id="multiplayer" checked /> Multiplayer</label>
    </div>
    <label class="field" for="chain">Chain</label>
    <select id="chain">
      <option value="97">BNB testnet</option>
      <option value="56">BNB Chain</option>
    </select>
    <div id="depositIntro">
      <ol class="flow">
        <li><span>1</span> Approve and deposit $10 USDT into ShareEscrow</li>
      </ol>
      <p class="empty">ShareEscrow 0xda4c60592E42DCC2AED553c38D1F8B517d89e3c7. NVDAB and XAUt are optional on the sign page.</p>
      <button class="next" id="metamaskDeposit" style="margin-top:8px">Deposit</button>
    </div>
  </div>
  <div id="app" style="display:none">
  <div class="stack">
    <button class="next" id="playFlappy">Play flappy</button>
    <button class="next" id="next">Play</button>
    <button class="next" id="rematch" style="display:none">Rematch</button>
  </div>

  <div class="actions">
    <button class="secondary" id="connect">Connect</button>
    <button class="secondary" id="refresh">Refresh</button>
    <button class="secondary" id="openBoard">Open board</button>
  </div>

  <h2>Lobby</h2>
  <div id="peers"></div>

  <div id="challengeBlock" style="display:none">
    <h2>Challenges</h2>
    <div id="challenges"></div>
  </div>

  <div id="pingBlock" style="display:none">
    <h2>Pings</h2>
    <div id="pings"></div>
  </div>

  <details>
    <summary>Room</summary>
    <div id="room" class="card" style="display:none"></div>
    <input id="roomCode" placeholder="Room code (e.g. AB12)" />
    <div class="actions">
      <button id="createRoom">Create room</button>
      <button class="secondary" id="joinRoom">Join</button>
      <button class="secondary" id="leaveRoom">Leave</button>
    </div>
  </details>
  </div>

  <h2>Ledger</h2>
  <div class="feed" id="ledgerFeed"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    $('connect').onclick = () => vscode.postMessage({ type: 'connect' });
    $('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
    $('openBoard').onclick = () => vscode.postMessage({ type: 'openBoard' });
    $('playFlappy').onclick = () => vscode.postMessage({ type: 'playFlappy' });
    $('createRoom').onclick = () => vscode.postMessage({ type: 'createRoom' });
    $('joinRoom').onclick = () => vscode.postMessage({ type: 'joinRoom', code: $('roomCode').value });
    $('leaveRoom').onclick = () => vscode.postMessage({ type: 'leaveRoom' });
    $('next').onclick = () => vscode.postMessage({ type: 'next' });
    $('rematch').onclick = () => {
      const game = rematchOffer && rematchOffer.game ? rematchOffer.game : lastGame;
      vscode.postMessage({ type: 'rematch', game });
    };
    $('claimBalance').onclick = () => vscode.postMessage({ type: 'claimBalance' });
    $('metamaskDeposit').onclick = depositWithMetaMask;
    $('depositMore').onclick = depositWithMetaMask;
    function depositWithMetaMask() {
      const games = Array.from(document.querySelectorAll('[data-game]:checked')).map((el) => el.getAttribute('data-game'));
      vscode.postMessage({
        type: 'metamaskDeposit',
        games,
        multiplayer: $('multiplayer').checked,
        chainId: Number($('chain').value),
      });
    }
    $('multiplayer').onchange = () => {
      if ($('multiplayer').checked) document.querySelector('[data-game="chess"]').checked = true;
    };
    const escrow = {
      97: { deposit: '$0.10', stake: '$0.001', name: 'BNB testnet' },
      56: { deposit: '$10.00', stake: '$0.05', name: 'BNB Chain' }
    };
    function termsFor(chainId) {
      return escrow[chainId] || escrow[97];
    }

    let prefs = { onboarded: false, games: ['chess'], multiplayer: true };
    let rematchOffer = null;
    let lastGame = 'chess';
    function chessMulti() {
      return prefs.multiplayer && prefs.games.indexOf('chess') !== -1;
    }
    let verified = null;
    let latestDeposit = null;
    let promptRows = [];
    let settlementRows = [];
    let matchSettlement = null;
    let chainSettlements = [];
    function payoutHref(hash) {
      return typeof hash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(hash)
        ? 'https://testnet.bscscan.com/tx/' + hash
        : '';
    }
    function resultRow(match, me) {
      const href = payoutHref(match && match.payoutTx);
      if (!href || !match || match.status !== 'finished' || !match.result) return null;
      const draw = match.result.kind === 'draw';
      const won = match.result.kind === 'win' && me && match.result.winner === me.id;
      const title = draw ? 'Draw' : won ? 'Won' : 'Lost';
      const sign = draw ? '' : won ? '+' : '-';
      let amount = '';
      try {
        const units = BigInt(match.stakeWei || '0');
        const text = (Number(units) / 1e18).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
        if (text && text !== '0') amount = sign + '$' + text;
      } catch (err) {
        amount = '';
      }
      return { title: title, meta: 'BNB testnet', amount: amount, href: href };
    }
    function isSettlementHref(href) {
      return href.indexOf('https://testnet.bscscan.com/') === 0 || href.indexOf('https://bscscan.com/') === 0;
    }
    function takeSettlements(bank) {
      const list = [];
      const seen = {};
      const add = (row) => {
        const href = row && typeof row.href === 'string' ? row.href : '';
        if (!href || seen[href] || !isSettlementHref(href)) return;
        seen[href] = true;
        list.push({ title: row.line || 'Settlement', meta: 'Match', amount: '', href: href });
      };
      const ledger = bank && bank.ledger;
      if (ledger) for (const row of ledger) add(row);
      add(bank && bank.transfer);
      settlementRows = list;
    }
    const MATCH_STAKE = 1000000000000000n;

    function paintLedger() {
      const box = $('ledgerFeed');
      box.textContent = '';
      const results = [];
      const seen = {};
      const pushResult = (row) => {
        if (!row || !row.href || seen[row.href]) return;
        seen[row.href] = true;
        results.push(row);
      };
      pushResult(matchSettlement);
      for (const row of chainSettlements) pushResult(row);
      for (const row of settlementRows) pushResult(row);
      const groups = promptRows.map((prompt) => ({ prompt: prompt, results: [] }));
      const byTime = groups.slice().sort((a, b) => (a.prompt.at || 0) - (b.prompt.at || 0));
      const ordered = results.slice().sort((a, b) => (a.at || 0) - (b.at || 0));
      for (const result of ordered) {
        let host = null;
        for (const group of byTime) {
          if (!result.at || (group.prompt.at || 0) <= result.at) host = group;
        }
        if (!host && byTime.length) host = byTime[byTime.length - 1];
        if (host) host.results.push(result);
        else groups.push({ prompt: null, results: [result] });
      }
      if (!latestDeposit && !groups.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Deposit and prompt costs show here.';
        box.appendChild(empty);
        return;
      }
      const open = (event, href) => {
        event.preventDefault();
        vscode.postMessage({ type: 'openLink', href: href });
      };
      const draw = (row, links) => {
        const el = document.createElement(row.href && !(links && links.length) ? 'a' : 'div');
        el.className = 'feed-row';
        if (el.tagName === 'A') {
          el.href = row.href;
          el.addEventListener('click', (event) => open(event, row.href));
        }
        const main = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'feed-title';
        title.textContent = row.title || '';
        const meta = document.createElement('div');
        meta.className = 'feed-meta';
        meta.textContent = row.meta || '';
        if (links && links.length) {
          if (row.meta) meta.append(document.createTextNode(' · '));
          links.forEach((link, index) => {
            if (index) meta.append(document.createTextNode(' · '));
            const a = document.createElement('a');
            a.href = link.href;
            a.textContent = (link.title || 'Bet') + (link.amount ? ' ' + link.amount : '');
            a.addEventListener('click', (event) => open(event, link.href));
            meta.append(a);
          });
        }
        main.append(title, meta);
        const amount = document.createElement('div');
        amount.className = 'feed-amt';
        amount.textContent = row.amount || '';
        el.append(main, amount);
        box.appendChild(el);
      };
      if (latestDeposit) draw(latestDeposit);
      for (const group of groups) {
        if (group.prompt) draw(group.prompt, group.results);
        else if (group.results.length) draw(group.results[0]);
      }
    }

    function applyEscrow(msg) {
      verified = msg;
      $('bankBalance').textContent = msg.balanceUsd || '$0.00';
      $('balSub').textContent = 'USDT';
      $('balanceBlock').style.display = '';
      latestDeposit = msg.deposit || null;
      if (Array.isArray(msg.settlements) && msg.settlements.length) chainSettlements = msg.settlements;
      const funded = BigInt(msg.balance || '0') >= MATCH_STAKE;
      $('playFlappy').disabled = !funded;
      $('next').disabled = !funded;
      $('claimBalance').disabled = !funded;
      paintLedger();
    }

    function applyBank(bank) {
      const view = bank || {};
      if (!verified) {
        const hasBalance = !!(view.balance && view.balance !== '0');
        if (hasBalance) {
          $('bankBalance').textContent = view.balanceUsd || '$0.00';
          $('balanceBlock').style.display = '';
        }
      }
      takeSettlements(view);
      paintLedger();
      const funded = verified ? BigInt(verified.balance || '0') >= MATCH_STAKE : !!view.canPlay;
      $('claimBalance').disabled = verified ? !funded : !view.canClaim;
      $('playFlappy').disabled = !funded;
      $('next').disabled = !funded;
    }

    function applyPrefs(next) {
      prefs = next;
      document.querySelectorAll('[data-game]').forEach((el) => {
        el.checked = prefs.games.indexOf(el.getAttribute('data-game')) !== -1;
      });
      $('multiplayer').checked = !!prefs.multiplayer;
      if (prefs.chainId) $('chain').value = String(prefs.chainId);
      $('app').style.display = prefs.onboarded ? '' : 'none';
      $('depositIntro').style.display = prefs.onboarded ? 'none' : '';
      if (prefs.wallet && prefs.wallet.length > 12) {
        $('me').textContent = prefs.wallet.slice(0, 6) + '…' + prefs.wallet.slice(-4);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'prefs') {
        applyPrefs(msg.prefs);
        return;
      }
      if (msg.type === 'escrow') {
        applyEscrow(msg);
        return;
      }
      if (msg.type === 'credits') return;
      if (msg.type === 'prompts') {
        promptRows = Array.isArray(msg.rows) ? msg.rows : [];
        paintLedger();
        return;
      }
      if (msg.type === 'bank') {
        applyBank(msg.bank);
        return;
      }
      if (msg.type !== 'state') return;
      const s = msg.state;
      $('dot').className = 'dot' + (s.connected ? ' on' : '');
      matchSettlement = resultRow(s.match, s.me);
      paintLedger();
      const online = s.peers.length + (s.me ? 1 : 0);
      $('statusText').textContent = !s.connected
        ? 'Disconnected'
        : s.drawing
          ? 'Drawing'
          : s.seeking
            ? 'Waiting'
            : ('Connected · ' + online + ' online');
      const chessOver = s.match && s.match.status === 'finished' && !s.seeking && !s.drawing;
      const flapOver = s.flappy && s.flappy.status === 'done' && !s.flappy.seeking;
      rematchOffer = s.rematch || null;
      lastGame = s.lastGame || (flapOver && !chessOver ? 'flappy' : 'chess');
      const showRematch = chessOver || flapOver;
      $('rematch').style.display = showRematch ? '' : 'none';
      $('rematch').textContent = s.rematch && s.rematch.waiting
        ? 'Waiting for rematch…'
        : (s.rematch ? 'Accept rematch' : 'Rematch');
      $('next').textContent = !chessMulti()
        ? 'Play'
        : s.drawing
          ? 'Drawing…'
          : s.seeking
            ? 'Waiting…'
            : 'Next';
      $('me').textContent = prefs.wallet
        ? prefs.wallet.slice(0, 6) + '…' + prefs.wallet.slice(-4)
        : (s.me ? s.me.displayName : '');
      const errText = s.error || '';
      $('err').textContent = /USDC|treasury|0xE2ca5C8ed8589Dc61abE1B2c2Dae309d2f86410c/i.test(errText) ? '' : errText;

      if (s.room) {
        $('room').style.display = '';
        $('room').className = 'card';
        $('room').innerHTML = '<div class="row"><strong class="mono">' + s.room.code + '</strong><span class="badge">' +
          s.room.members.length + '</span></div>';
      } else {
        $('room').style.display = 'none';
        $('room').textContent = '';
      }

      const peers = $('peers');
      peers.innerHTML = '';
      for (const p of s.peers) {
        const el = document.createElement('div');
        el.className = 'card';
        el.innerHTML = '<div class="row"><div><strong>' + (p.displayName || 'Player') +
          '</strong></div><span class="badge">' +
          (p.waiting ? 'waiting' : p.host) +
          (p.roomCode ? ' · ' + p.roomCode : '') + '</span></div>';
        const actions = document.createElement('div');
        actions.className = 'actions';
        const pingBtn = document.createElement('button');
        pingBtn.className = 'secondary';
        pingBtn.textContent = 'Ping';
        pingBtn.onclick = () => vscode.postMessage({ type: 'ping', to: p.id, text: 'hello' });
        const chalBtn = document.createElement('button');
        chalBtn.textContent = 'Challenge';
        chalBtn.onclick = () => vscode.postMessage({ type: 'challenge', to: p.id });
        actions.append(pingBtn, chalBtn);
        el.append(actions);
        peers.append(el);
      }

      const ch = $('challenges');
      ch.innerHTML = '';
      $('challengeBlock').style.display = s.challenges.length ? '' : 'none';
      for (const c of s.challenges) {
        const el = document.createElement('div');
        el.className = 'card';
        el.innerHTML = '<div><strong>' + c.fromName + '</strong> challenged you</div>';
        const actions = document.createElement('div');
        actions.className = 'actions';
        const yes = document.createElement('button');
        yes.textContent = 'Accept';
        yes.onclick = () => {
          vscode.postMessage({ type: 'respond', challengeId: c.id, accept: true });
          vscode.postMessage({ type: 'openBoard' });
        };
        const no = document.createElement('button');
        no.className = 'secondary';
        no.textContent = 'Decline';
        no.onclick = () => vscode.postMessage({ type: 'respond', challengeId: c.id, accept: false });
        actions.append(yes, no);
        el.append(actions);
        ch.append(el);
      }

      const pings = $('pings');
      pings.innerHTML = '';
      const recent = (s.pings || []).slice().reverse().slice(0, 5);
      $('pingBlock').style.display = recent.length ? '' : 'none';
      for (const p of recent) {
        const el = document.createElement('div');
        el.className = 'card';
        el.textContent = p.fromName + ': ' + p.text;
        pings.append(el);
      }
    });
    paintLedger();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
