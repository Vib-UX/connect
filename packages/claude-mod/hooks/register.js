/**
 * Connect Claude Code mod.
 * /connect opens one pane. Chess and Flappy are picked inside it.
 * A prompt starts the selected game. Flappy flies on this machine; the relay
 * only compares the final scores. The person plays.
 * The agent is not a player. This file has no Node APIs: the MCP process
 * in .mcp.json owns the single relay socket.
 */

const PANE = "connect";

let game = "chess";
let paneOpen = false;
let letters = false;
let columns = 60;
let zoom = 3;
let selected = null;
let lastError = "";
let seenFen = "";
let lastMove = null;
let lastMatchId = "";
let tickN = 0;
let pendingFlappy = null;
let chain = Promise.resolve();
let mcpServer = "";
let snap = emptySnap();
let prompts = [];
let forwardedPrompt = "";

function emptySnap() {
  return {
    me: null,
    peers: [],
    match: null,
    flappy: null,
    bank: null,
    rematch: null,
    seeking: false,
    waiting: 0,
    drawing: false,
    legalMoves: [],
  };
}

function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

function parseToolText(text) {
  const body = String(text || "").trim();
  if (!body) return {};
  const marker = "\n\n---\n";
  const idx = body.lastIndexOf(marker);
  const jsonText = idx >= 0 ? body.slice(idx + marker.length) : body;
  return JSON.parse(jsonText);
}

/** The plugin's own server runs as `plugin:connect:connect`; connect() names it. */
async function serverName($) {
  if (mcpServer) return mcpServer;
  const res = await $.mcp.connect("connect");
  if (!res.isConnected) throw new Error(`Connect MCP not connected: ${res.message || res.reason || "unknown"}`);
  mcpServer = res.server;
  return mcpServer;
}

async function callTool($, name, args) {
  const result = await $.mcp.call(await serverName($), name, args || {});
  const text = (result.content || [])
    .map((block) => (block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
  if (result.isError) throw new Error(text.trim() || `${name} failed`);
  return parseToolText(text);
}

function liveChess() {
  return Boolean(snap.match && snap.match.status !== "finished");
}

function myColor() {
  const me = snap.me && snap.me.id;
  if (!snap.match || !me) return "w";
  return snap.match.black === me ? "b" : "w";
}

function myTurn() {
  const match = snap.match;
  if (!match || match.status !== "active") return false;
  return match.turn === myColor();
}

function nameOf(id) {
  const peer = (snap.peers || []).find((item) => item.id === id);
  return (peer && peer.displayName) || id || "opponent";
}

function opponentName() {
  const match = snap.match;
  const me = snap.me && snap.me.id;
  if (!match || !me) return "opponent";
  return nameOf(match.white === me ? match.black : match.white);
}

function statusLine() {
  if (game === "flappy") {
    const flap = snap.flappy;
    if (!flap || flap.status === "waiting") return "connect: flappy · waiting for a player";
    if (flap.status === "playing" && flap.you == null) return "connect: flappy · you fly, then we compare";
    if (flap.status === "playing") return `connect: flappy · you ${flap.you} · waiting for ${flap.themName || "them"}`;
    if (flap.winner === "draw") return `connect: flappy · draw ${flap.you}`;
    if (flap.winner === "you") return `connect: flappy · you win ${flap.you} to ${flap.them}`;
    return `connect: flappy · ${flap.themName || "they"} win ${flap.them} to ${flap.you}`;
  }
  if (snap.drawing) return "connect: chess · drawing colors";
  if (snap.seeking && !liveChess()) return "connect: chess · waiting for a player";
  if (liveChess() && myTurn()) return `connect: chess · your move vs ${opponentName()}`;
  if (liveChess()) return `connect: chess · waiting on ${opponentName()}`;
  return "connect: chess · prompt to find a player";
}

function paintStatus($) {
  if (!paneOpen) return;
  $.ui.status(statusLine());
}

/** The move between two positions, from the squares that changed. */
function moveBetween(prevFen, nextFen) {
  if (!prevFen || !nextFen) return null;
  const before = piecesFromFen(prevFen);
  const after = piecesFromFen(nextFen);
  const emptied = [];
  const filled = [];
  for (const file of "abcdefgh") {
    for (let rank = 1; rank <= 8; rank++) {
      const sq = `${file}${rank}`;
      if (before[sq] === after[sq]) continue;
      if (before[sq] && !after[sq]) emptied.push(sq);
      else if (after[sq]) filled.push(sq);
    }
  }
  if (!emptied.length || !filled.length) return null;
  // Castling moves two pieces: the king's squares name the move.
  const from = emptied.find((sq) => "Kk".includes(before[sq])) || emptied[0];
  const to = filled.find((sq) => after[sq] === before[from]) || filled[0];
  return from + to;
}

function applySnap(data) {
  if (!data || typeof data !== "object") return;
  if (data.match && data.match.fen && data.match.fen !== seenFen) {
    const same = data.match.matchId === lastMatchId;
    lastMove = same && data.match.status !== "finished" ? moveBetween(seenFen, data.match.fen) : null;
    lastMatchId = data.match.matchId;
    selected = null;
    seenFen = data.match.fen;
  }
  if (data.match && data.match.status === "finished") selected = null;
  snap = {
    ...snap,
    ...data,
    peers: Array.isArray(data.peers) ? data.peers : snap.peers,
    legalMoves: Array.isArray(data.legalMoves) ? data.legalMoves : snap.legalMoves,
    flappy: data.flappy === undefined ? snap.flappy : data.flappy,
    bank: data.bank === undefined ? snap.bank : data.bank,
    rematch: data.rematch === undefined ? snap.rematch : data.rematch,
  };
}

async function refresh($) {
  applySnap(await callTool($, "connect_poll", {}));
  // The MCP process syncs the balance once the MetaMask page confirms. Drop the page line then.
  if (depositUrl && funded()) depositUrl = "";
  lastError = "";
  paintStatus($);
  $.ui.invalidate("ui.render");
}

async function forwardPrompt($, text, promptId) {
  const known = String(text || "").replace(/\s+/g, " ").trim();
  const id = String(promptId || "");
  if (!known || (id && forwardedPrompt === id)) return Boolean(known && forwardedPrompt === id);
  try {
    await callTool($, "connect_prompt", { prompt: known.slice(0, 8000), model: "claude", promptId: id });
    if (id) forwardedPrompt = id;
    return true;
  } catch {
    return false;
  }
}

function promptArgs(session) {
  const args = {};
  const prompt = session && session.prompt ? String(session.prompt).replace(/\s+/g, " ").trim().slice(0, 8000) : "";
  const model = session && session.model ? String(session.model).trim().slice(0, 80) : "";
  const promptId = session && session.promptId ? String(session.promptId).trim().slice(0, 80) : "";
  if (prompt) args.prompt = prompt;
  if (model) args.model = model;
  if (promptId) args.promptId = promptId;
  return args;
}

async function startFromPrompt($, session) {
  if (!funded()) {
    lastError = "Deposit USDT on BNB before you play.";
    paintStatus($);
    $.ui.invalidate("ui.render");
    return;
  }
  const args = promptArgs(session);
  if (game === "chess") {
    if (!liveChess()) applySnap(await callTool($, "connect_next", args));
  } else if (!snap.flappy || snap.flappy.status !== "playing") {
    applySnap(await callTool($, "connect_flappy_join", args));
  }
  await refresh($);
}

function insightRow(Text) {
  if (!snap.insight || !snap.insight.reason) return null;
  return Text({ key: "insight", color: "subtle", children: [String(snap.insight.reason)] });
}

function piecesFromFen(fen) {
  const map = {};
  if (!fen) return map;
  const ranks = String(fen).split(" ")[0].split("/");
  for (let r = 0; r < ranks.length; r++) {
    let file = 0;
    for (const ch of ranks[r]) {
      if (ch >= "1" && ch <= "8") {
        file += Number(ch);
      } else {
        map[`abcdefgh`[file] + (8 - r)] = ch;
        file += 1;
      }
    }
  }
  return map;
}

function isMine(piece, color) {
  if (!piece) return false;
  const white = piece === piece.toUpperCase();
  return color === "w" ? white : !white;
}

function clock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function noteError($, err) {
  lastError = err instanceof Error ? err.message : String(err);
  try {
    $.ui.invalidate("ui.render");
  } catch {
    /* the pane may already be gone */
  }
}

async function playMove($, text) {
  const match = snap.match;
  if (!match) return;
  await callTool($, "connect_move", { matchId: match.matchId, uci: String(text || "") });
  await refresh($);
}

function onSquare($, sq) {
  const match = snap.match;
  if (!match || match.status !== "active") return;
  const pieces = piecesFromFen(match.fen);
  const piece = pieces[sq];
  const legal = snap.legalMoves || [];
  if (selected) {
    const options = legal.filter((move) => move.slice(0, 2) === selected && move.slice(2, 4) === sq);
    if (options.length && myTurn()) {
      const queen = options.find((move) => move.length === 4 || move.endsWith("q"));
      const uci = queen || options[0];
      selected = null;
      enqueue(() => playMove($, uci)).catch((err) => noteError($, err));
      return;
    }
  }
  if (isMine(piece, myColor()) && myTurn()) {
    selected = selected === sq ? null : sq;
  } else {
    selected = null;
  }
  $.ui.invalidate("ui.render");
}

async function flushFlappy($) {
  if (!pendingFlappy) return;
  const { contestId, score } = pendingFlappy;
  applySnap(await callTool($, "connect_flappy_score", { contestId, score }));
  if (snap.flappy && snap.flappy.you != null) pendingFlappy = null;
  await refresh($);
}

async function findPlayer($) {
  if (!funded()) {
    lastError = "Deposit USDT on BNB before you play.";
    paintStatus($);
    $.ui.invalidate("ui.render");
    return;
  }
  if (liveChess() || snap.seeking) return;
  applySnap(await callTool($, "connect_next", {}));
  await refresh($);
}

function settlementHref() {
  const bank = snap.bank;
  const rows = [];
  if (bank && bank.transfer) rows.push(bank.transfer);
  if (bank && Array.isArray(bank.ledger)) rows.push(...bank.ledger);
  for (const row of rows) {
    const href = row && row.href;
    if (typeof href === "string" && /^https:\/\/(testnet\.bscscan\.com|bscscan\.com)\//.test(href)) return href;
  }
  return "";
}

function onlineCount() {
  const me = snap.me;
  const seen = new Set();
  for (const peer of snap.peers || []) {
    if (!peer || (me && peer.id === me.id)) continue;
    if (me && me.owner && peer.owner === me.owner) continue;
    if (me && !peer.owner && peer.host === me.host) continue;
    seen.add(peer.owner || `host:${peer.host}`);
  }
  return seen.size + (me ? 1 : 0);
}

function identityLine(Text) {
  const me = snap.me;
  if (!me) return Text({ key: "who", color: "warning", children: ["◌ connecting to the relay…"] });
  const online = onlineCount();
  return Text({
    key: "who",
    dimColor: true,
    children: [`● ${me.displayName} · ${online} online`],
  });
}

const PAYOUT_CHAINS = [
  { id: 97, name: "BNB testnet" },
  { id: 56, name: "BNB Chain" },
];
const ESCROW = "0xda4c60592E42DCC2AED553c38D1F8B517d89e3c7";
let payoutChain = 97;
let walletDraft = "";
let depositUrl = "";

function funded() {
  return Boolean(snap.bank && snap.bank.canPlay);
}

async function checkDeposit($) {
  const wallet = (walletDraft || (snap.me && snap.me.walletAddress) || "").trim();
  applySnap(await callTool($, "connect_set_player", { wallet, chainId: payoutChain }));
  applySnap(await callTool($, "connect_sync_deposit", {}));
  lastError = funded() ? "" : "No USDT in the escrow yet.";
}

/** Same MetaMask page the Cursor sidebar opens. The MCP process serves it and syncs the balance once it confirms. */
async function openDeposit($) {
  const res = await callTool($, "connect_deposit", { chainId: payoutChain });
  depositUrl = res.url || "";
  lastError = "";
  $.ui.invalidate("ui.render");
}

function depositBlock($, ui) {
  const { Box, Text, Button, Input } = ui;
  const bank = snap.bank;
  const address = payoutChain === 97 ? ESCROW : (bank && bank.address) || "BNB Chain escrow is not deployed yet";
  const chainName = (PAYOUT_CHAINS.find((item) => item.id === payoutChain) || PAYOUT_CHAINS[0]).name;
  const balance = (bank && bank.balanceUsd) || "$0.00";
  const rows = [
    Text({
      key: "deposit-hint",
      children: [`MetaMask signs each step on ${chainName}. The account that signs is the one Connect credits.`],
    }),
    ...(payoutChain === 97
      ? [
          Text({ key: "deposit-usdt", children: [`1. Mint $10 testnet USDT, then approve and deposit it into ${ESCROW}`] }),
          Text({ key: "deposit-shares", color: "subtle", children: [`NVDAB and XAUt are optional on the sign page.`] }),
        ]
      : [Text({ key: "deposit-main", children: ["The BNB Chain escrow is not deployed yet."] })]),
    Text({ key: "deposit-address", color: "claude", children: [address] }),
    Text({ key: "deposit-balance", children: [`Balance ${balance}`] }),
  ];
  if (bank && bank.note) rows.push(Text({ key: "deposit-note", color: "subtle", children: [bank.note] }));
  if (depositUrl) {
    rows.push(
      Text({
        key: "deposit-page",
        color: "subtle",
        children: [`MetaMask page opened: ${depositUrl}. Sign there and the balance updates here.`],
      }),
    );
  }
  rows.push(
    Input({
      key: "wallet",
      label: "wallet",
      placeholder: "0x…",
      onSubmit: (value) => {
        walletDraft = String(value || "");
        enqueue(() => checkDeposit($)).catch((err) => noteError($, err));
      },
    }),
  );
  rows.push(
    Box({
      key: "chains",
      flexDirection: "row",
      gap: 1,
      children: PAYOUT_CHAINS.map((item) =>
        Button({
          key: `chain-${item.id}`,
          label: item.name,
          dimColor: item.id !== payoutChain,
          onPress: () => {
            payoutChain = item.id;
            $.ui.invalidate("ui.render");
          },
        }),
      ),
    }),
  );
  rows.push(
    Box({
      key: "deposit-actions",
      flexDirection: "row",
      gap: 1,
      children: [
        Button({
          key: "metamask-deposit",
          label: "Deposit",
          dimColor: payoutChain !== 97,
          onPress: act($, () => openDeposit($)),
        }),
        Button({
          key: "check-deposit",
          label: "Check deposit",
          onPress: act($, () => checkDeposit($)),
        }),
        Button({
          key: "claim-balance",
          label: (bank && bank.claimLabel) || "Claim",
          dimColor: !(bank && bank.canClaim),
          onPress: act($, async () => {
            if (!bank || !bank.canClaim) return;
            applySnap(await callTool($, "connect_claim", {}));
            await refresh($);
          }),
        }),
      ],
    }),
  );
  return rows;
}

const EXPLORER = /^https:\/\/(?:testnet\.)?bscscan\.com\/tx\/0x[a-fA-F0-9]{64}\/?$/;

/** Won, Lost or Draw for the match on screen, or "" while nothing has settled. */
function currentResult() {
  const match = snap.match;
  if (match && match.status === "finished" && match.result) {
    if (match.result.kind === "draw") return "Draw";
    return match.result.winner === snap.me?.id ? "Won" : "Lost";
  }
  const flap = snap.flappy;
  if (flap && flap.status === "done") return flap.winner === "you" ? "Won" : flap.winner === "them" ? "Lost" : "Draw";
  return "";
}

function resultFromLine(line) {
  const text = String(line || "");
  if (/^draw\b/i.test(text)) return "Draw";
  if (/^won\b/i.test(text) || /\byou won\b/i.test(text)) return "Won";
  if (/^lost\b/i.test(text) || /\byou lost\b/i.test(text)) return "Lost";
  return "";
}

/** Win/loss sized like the last finished prompt, not the fixed escrow stake. */
function promptPrize(result) {
  const row = prompts.find((item) => item.usage);
  const cost = row ? promptCost(row.usage) : 0;
  if (cost <= 0) return "";
  const amount = `$${cost.toFixed(4)}`;
  return result === "Won" ? `+${amount}` : result === "Lost" ? `-${amount}` : amount;
}

function settleLabel(result) {
  const prize = result ? promptPrize(result) : "";
  return `${result || "Settlement"}${prize ? ` ${prize}` : ""} · prompt cost on BNB testnet`;
}

/** The match settlement and the last claim, each with its BscScan link, as the Cursor board shows them. */
function txTrail(ui) {
  const { Box, Text, Link } = ui;
  const bank = snap.bank;
  const rows = [];
  // Only the current match, priced by prompt cost — not the stake or the whole win history.
  const result = currentResult();
  if (result) {
    const href = settlementHref();
    rows.push({ key: "tx-result", label: settleLabel(result), href: EXPLORER.test(href) ? href : "" });
  } else if (bank && bank.transfer && bank.transfer.line) {
    const transfer = bank.transfer;
    rows.push({
      key: "tx-transfer",
      label: settleLabel(resultFromLine(transfer.line)),
      href: EXPLORER.test(transfer.href || "") ? transfer.href : "",
    });
  }
  const payout = bank && bank.payout;
  if (payout && EXPLORER.test(payout.href || "")) {
    rows.push({ key: "tx-payout", label: "Claim · prompt cost on BNB testnet", href: payout.href });
  }
  if (!rows.length) return null;
  return Box({
    key: "tx-trail",
    flexDirection: "column",
    children: rows.map((row) =>
      Box({
        key: row.key,
        flexDirection: "column",
        children: [
          Text({ key: "label", color: "claude", children: [row.label] }),
          row.href ? Text({ key: "link", children: [Link({ key: "href", href: row.href, label: row.href })] }) : null,
        ].filter(Boolean),
      }),
    ),
  });
}

/** USD per million tokens, the same estimate the Cursor sidebar uses. */
function rates(model) {
  const id = String(model || "").toLowerCase();
  if (id.includes("haiku")) return { input: 1, output: 5 };
  if (id.includes("opus") || id.includes("fable")) return { input: 15, output: 75 };
  return { input: 3, output: 15 };
}

function promptCost(usage) {
  const price = rates(usage.model);
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const fresh = usage.input_tokens || 0;
  return (fresh * price.input + read * price.input * 0.1 + write * price.input * 1.25 + (usage.output_tokens || 0) * price.output) / 1_000_000;
}

function commas(n) {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString("en-US");
}

/** `/connect prompts`: this session's prompts with their estimated cost, printed so the pane stays clean. */
function promptReport() {
  if (!prompts.length) return "No prompts yet this session.";
  let total = 0;
  const lines = prompts.map((row) => {
    const title = row.text.length > 72 ? `${row.text.slice(0, 71)}…` : row.text;
    if (!row.usage) return `…        ${title}\n         running`;
    const cost = promptCost(row.usage);
    total += cost;
    const tokens = `${commas(row.usage.input_tokens + (row.usage.cache_read_input_tokens || 0) + (row.usage.cache_creation_input_tokens || 0))} in / ${commas(row.usage.output_tokens)} out`;
    return `$${cost.toFixed(4)}  ${title}\n         ${row.usage.model} · ${tokens} · est`;
  });
  return [...lines, "", `$${total.toFixed(4)} across ${prompts.length} prompt${prompts.length === 1 ? "" : "s"} (estimate)`].join("\n");
}

function act($, fn) {
  return () => {
    enqueue(() => fn()).catch((err) => noteError($, err));
  };
}

// Board widths for board.js sizes: eight squares of 3, 5, 7 or 9 cells plus rank labels.
const BOARD_WIDTH = [26, 42, 58, 74];

/** The size board.js draws: the zoom picked, capped by what the pane holds. */
function boardSize() {
  let fit = 0;
  while (fit + 1 < BOARD_WIDTH.length && BOARD_WIDTH[fit + 1] <= columns) fit += 1;
  return Math.min(zoom, fit);
}

async function zoomBy($, step) {
  zoom = Math.min(BOARD_WIDTH.length - 1, Math.max(0, boardSize() + step));
  if (BOARD_WIDTH[zoom] > columns) {
    columns = BOARD_WIDTH[zoom];
    await openPane($);
  }
  $.ui.invalidate("ui.render");
}

function renderChess($, ui) {
  const { Box, Text, Button, Input, Client } = ui;
  const match = snap.match;
  const active = Boolean(match && match.status === "active");
  const rows = [identityLine(Text)];
  const insight = insightRow(Text);
  if (insight) rows.push(insight);

  if (!match || match.status !== "active") {
    const wait = snap.drawing
      ? "Drawing colors…"
      : snap.seeking
        ? "Looking for an opponent… they join when they prompt."
        : "Find a player, or just send a prompt. Their prompt starts the game.";
    rows.push(Text({ key: "wait", color: snap.seeking || snap.drawing ? "warning" : "text", children: [wait] }));
    if (match && match.result) {
      const won = match.result.kind === "win" && match.result.winner === snap.me?.id;
      const label = match.result.kind === "draw" ? "Draw" : won ? "You won" : "You lost";
      rows.push(
        Text({
          key: "result",
          weight: "bold",
          color: match.result.kind === "draw" ? "warning" : won ? "success" : "error",
          children: [`${label} · ${match.result.reason}`],
        }),
      );
      const balance = snap.bank && snap.bank.balance && snap.bank.balance !== "0" ? snap.bank.balanceUsd : "";
      if (balance) {
        rows.push(
          Text({
            key: "claim-later",
            color: "subtle",
            children: [`Balance ${balance}. Claim it whenever you want.`],
          }),
        );
      }
    }
    if (match && match.result && !snap.seeking && !snap.drawing) {
      const offer = snap.rematch && snap.rematch.game === "chess" ? snap.rematch : null;
      rows.push(
        Button({
          key: "rematch",
          label: offer && offer.waiting ? "Waiting for rematch…" : offer ? "Accept rematch" : "Rematch",
          hotkey: "r",
          onPress: act($, async () => {
            applySnap(await callTool($, "connect_rematch", { game: "chess" }));
            await refresh($);
          }),
        }),
      );
    }
    if (!snap.seeking && !snap.drawing) {
      rows.push(
        Box({
          key: "find",
          children: [
            Button({ key: "find-player", label: "Find a player", hotkey: "f", onPress: act($, () => findPlayer($)) }),
          ],
        }),
      );
    }
    return rows;
  }

  const color = myColor();
  const legal = snap.legalMoves || [];
  const dests = selected ? legal.filter((move) => move.slice(0, 2) === selected).map((move) => move.slice(2, 4)) : [];
  const turn = myTurn();
  const clocks = match.clocksMs || null;
  const mine = clocks ? clock(clocks[color]) : "";
  const theirs = clocks ? clock(clocks[color === "w" ? "b" : "w"]) : "";

  rows.push(
    Box({
      key: "players",
      flexDirection: "row",
      justifyContent: "space-between",
      children: [
        Text({ key: "opp", children: [`${color === "w" ? "♚" : "♔"} ${opponentName()}`] }),
        Text({ key: "opp-clock", color: !turn && active ? "warning" : "subtle", weight: "bold", children: [theirs] }),
      ],
    }),
  );
  rows.push(
    Client({
      key: "board",
      module: "./board.js",
      props: {
        game: "chess",
        fen: match.fen,
        color,
        selected,
        dests,
        lastMove,
        letters,
        active,
        zoom,
      },
    }),
  );
  rows.push(
    Box({
      key: "zoom",
      flexDirection: "row",
      gap: 2,
      children: [
        Button({ key: "zoom-out", label: "Zoom −", hotkey: "o", dimColor: true, onPress: act($, () => zoomBy($, -1)) }),
        Button({ key: "zoom-in", label: "Zoom +", hotkey: "i", dimColor: true, onPress: act($, () => zoomBy($, 1)) }),
      ],
    }),
  );
  rows.push(
    Box({
      key: "me",
      flexDirection: "row",
      justifyContent: "space-between",
      children: [
        Text({
          key: "turn",
          weight: "bold",
          color: !active ? "subtle" : turn ? "success" : "subtle",
          children: [
            !active ? "Game over" : turn ? `▶ Your move (${color === "w" ? "White" : "Black"})` : "Their move…",
          ],
        }),
        Text({ key: "my-clock", color: turn ? "success" : "subtle", weight: "bold", children: [mine] }),
      ],
    }),
  );
  if (active) {
    rows.push(
      Input({
        key: "move",
        label: "move",
        placeholder: "or type e4, Nf3, O-O",
        onSubmit: (value) => {
          enqueue(() => playMove($, value)).catch((err) => noteError($, err));
        },
      }),
    );
    rows.push(
      Box({
        key: "actions",
        flexDirection: "row",
        children: [
          Button({
            key: "resign",
            label: "Resign",
            dimColor: true,
            onPress: act($, async () => {
              await callTool($, "connect_resign", { matchId: match.matchId });
              await refresh($);
            }),
          }),
        ],
      }),
    );
  }
  return rows;
}

function flappyClaim(flap) {
  const usd = (flap && flap.balanceUsd) || (snap.bank && snap.bank.balanceUsd) || "";
  if (!usd || usd === "$0.00" || (snap.bank && snap.bank.balance === "0")) return "";
  return ` Balance ${usd}. Claim it whenever you want.`;
}

function renderFlappy($, ui) {
  const { Text, Button, Client } = ui;
  const flap = snap.flappy;
  const playing = flap && flap.status === "playing";
  const rows = [identityLine(Text)];
  const insight = insightRow(Text);
  if (insight) rows.push(insight);
  const line =
    !flap || flap.status === "waiting"
      ? "Waiting for the other player to prompt."
      : flap.status === "done" && flap.winner === "you"
        ? `You win ${flap.you} to ${flap.them}.${flappyClaim(flap)}`
        : flap.status === "done" && flap.winner === "them"
          ? `${flap.themName || "They"} win ${flap.them} to ${flap.you}.${flappyClaim(flap)}`
          : flap.status === "done"
            ? `Draw. ${flap.you} each.${flappyClaim(flap)}`
            : flap.you == null
              ? `Flying against ${flap.themName || "the other player"}. The relay compares the final scores.`
              : `You scored ${flap.you}. Waiting for ${flap.themName || "them"}.`;
  rows.push(Text({ key: "flappy-status", color: flap && flap.status === "done" ? "success" : "subtle", children: [line] }));
  rows.push(
    Client({
      key: "flappy-board",
      module: "./board.js",
      props: {
        game: "flappy",
        contestId: playing ? flap.id : "",
        seed: playing ? flap.seed : 0,
        status: flap ? flap.status : "waiting",
        you: flap ? flap.you : null,
        them: flap ? flap.them : null,
        themName: flap ? flap.themName || "" : "",
        winner: flap ? flap.winner : null,
      },
    }),
  );
  if (!playing) {
    const done = flap && flap.status === "done";
    const offer = snap.rematch && snap.rematch.game === "flappy" ? snap.rematch : null;
    rows.push(
      Button({
        key: "find-flappy",
        label: done ? "New opponent" : "Find a player",
        hotkey: "f",
        onPress: act($, () => startFromPrompt($)),
      }),
    );
    if (done) {
      rows.push(
        Button({
          key: "rematch-flappy",
          label: offer && offer.waiting ? "Waiting for rematch…" : offer ? "Accept rematch" : "Rematch",
          hotkey: "r",
          onPress: act($, async () => {
            applySnap(await callTool($, "connect_rematch", { game: "flappy" }));
            await refresh($);
          }),
        }),
      );
    }
  }
  return rows;
}

function tab($, ui, id, label, hotkey) {
  const { Button, Text } = ui;
  const on = game === id;
  return Button({
    key: `pick-${id}`,
    hotkey,
    plain: true,
    onPress: () => {
      game = id;
      paintStatus($);
      $.ui.invalidate("ui.render");
    },
    children: [
      Text({
        key: "t",
        weight: on ? "bold" : "regular",
        color: on ? "claude" : "subtle",
        underline: on,
        children: [label],
      }),
    ],
  });
}

function renderPane($, ui) {
  const { Box, Text, Button } = ui;
  const error = lastError ? Text({ key: "error", color: "error", children: [`! ${lastError}`] }) : null;
  const ready = funded();
  const chainName = (PAYOUT_CHAINS.find((item) => item.id === payoutChain) || PAYOUT_CHAINS[0]).name;
  const body = ready ? (game === "flappy" ? renderFlappy($, ui) : renderChess($, ui)) : depositBlock($, ui);
  const balance =
    ready && snap.bank
      ? Box({
          key: "funded",
          flexDirection: "row",
          gap: 2,
          children: [
            Text({ key: "funded-balance", color: "subtle", children: [`${snap.bank.balanceUsd} · claim pays ${chainName}`] }),
            Button({
              key: "claim-funded",
              label: snap.bank.claimLabel || "Claim",
              dimColor: !snap.bank.canClaim,
              onPress: act($, async () => {
                applySnap(await callTool($, "connect_claim", {}));
                await refresh($);
              }),
            }),
          ],
        })
      : null;
  return Box({
    flexDirection: "column",
    gap: 1,
    children: [
      Box({
        key: "tabs",
        flexDirection: "row",
        gap: 2,
        children: ready
          ? [tab($, ui, "chess", "♞ Chess", "c"), tab($, ui, "flappy", "▸ Flappy", "f")]
          : [Text({ key: "locked", color: "warning", children: ["Deposit on BNB to play"] })],
      }),
      balance,
      txTrail(ui),
      error,
      ...body,
    ].filter(Boolean),
  });
}

async function openPane($) {
  paneOpen = true;
  const pane = { id: PANE, title: "Connect", focus: true, closeOnEscape: true };
  if (columns) pane.columns = columns;
  await $.ui.open(pane);
  paintStatus($);
}

export function register(on, options = {}) {
  letters = options.pieces === "letters";
  const width = Number(options.columns);
  if (width >= 30 && width <= 100) columns = Math.round(width);

  on("session.start", async ($, e, next) => {
    try {
      if (options.display_name) await $.env.set("CONNECT_DISPLAY_NAME", String(options.display_name));
      if (options.relay_url) await $.env.set("CONNECT_RELAY_URL", String(options.relay_url));
    } catch {
      /* the manifest env is used when the MCP process is already up */
    }
    $.clock.every(400, () => {
      if (!paneOpen) return;
      tickN += 1;
      const flap = snap.flappy;
      const flappyHot =
        game === "flappy" &&
        (pendingFlappy ||
          flap?.status === "waiting" ||
          (flap?.status === "playing" && flap.you != null && flap.them == null));
      const depositing = Boolean(depositUrl) && !funded();
      const hot = flappyHot || depositing || snap.seeking || snap.drawing || liveChess() || Boolean(snap.rematch);
      if (!hot && tickN % 5 !== 0) return;
      enqueue(async () => {
        if (pendingFlappy) await flushFlappy($);
        else await refresh($);
      }).catch((err) => noteError($, err));
    });
    try {
      await $.command.register({
        name: "connect",
        description: "Open Connect. Pick Chess or Flappy, then prompt to start.",
        argumentHint: "[chess|flappy|prompts|stop]",
      });
    } catch {
      /* a taken name must not block the rest of startup */
    }
    return next(e);
  });

  on("command.run", { command: "connect" }, async ($, e) => {
    const arg = String(e.args || "").trim().toLowerCase();
    if (arg === "stop") {
      paneOpen = false;
      $.ui.status(undefined);
      await $.ui.close({ id: PANE });
      return {};
    }
    if (arg === "prompts") return { text: promptReport() };
    if (arg === "chess" || arg === "flappy") game = arg;
    await openPane($);
    enqueue(() => refresh($)).catch((err) => noteError($, err));
    return {};
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    return renderPane($, $.ui.resolve(e));
  });

  on("ui.message", async ($, e, next) => {
    if (e.element !== "board" && e.element !== "flappy-board") return next(e);
    const data = e.data && typeof e.data === "object" ? e.data : {};
    if (data.kind === "square" && /^[a-h][1-8]$/.test(String(data.sq))) {
      onSquare($, String(data.sq));
    } else if (data.kind === "flappy-score" && data.contestId) {
      const score = Math.floor(Number(data.score));
      if (score >= 0 && score <= 9999) {
        pendingFlappy = { contestId: String(data.contestId), score };
        enqueue(() => flushFlappy($)).catch((err) => noteError($, err));
      }
    }
    return next(e);
  });

  on("ui.close", async ($, e, next) => {
    if (e.id === PANE) paneOpen = false;
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    const text = String(e.text || "").replace(/\s+/g, " ").trim();
    if (e.agentId === undefined && text) {
      prompts = [{ turnId: e.turnId, text, usage: null }, ...prompts.filter((row) => row.turnId !== e.turnId)].slice(0, 20);
      await forwardPrompt($, text, e.turnId).catch(() => {});
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const row = e.agentId === undefined ? prompts.find((item) => item.turnId === e.turnId) : null;
    if (row && e.usage) {
      row.usage = e.usage;
      // The settlement line is priced from this prompt.
      if (paneOpen) $.ui.invalidate("ui.render");
    }
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    const text = String((e && (e.prompt || e.text || e.message)) || "").replace(/\s+/g, " ").trim();
    const promptId = String((e && (e.turnId || e.promptId)) || `turn_${Date.now()}`);
    if (text) {
      prompts = [{ turnId: promptId, text, usage: null }, ...prompts.filter((row) => row.turnId !== promptId)].slice(0, 20);
    }
    try {
      if (!paneOpen) await openPane($);
      const known = text || (prompts[0] && prompts[0].text) || "";
      const forwarded = await forwardPrompt($, known, promptId);
      await enqueue(() =>
        startFromPrompt($, forwarded ? { model: "claude", promptId } : { prompt: known, model: "claude", promptId }),
      );
    } catch (err) {
      noteError($, err);
    }
    return next(e);
  });
}
