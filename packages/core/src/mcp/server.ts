import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { legalUci, matchSummary, toUci } from "../board.js";
import { renderSnake } from "../snake-board.js";
import { ConnectClient } from "../connect.js";
import { depositPage, openInBrowser, startDepositPage } from "../deposit-page.js";
import type { ChessState, HostKind, ServerMessage, SnakeDir, SnakeState } from "../types.js";

export interface McpServerOptions {
  host: HostKind;
  displayName?: string;
  relayUrl?: string;
}

function boardFromMessage(msg: ServerMessage): string | null {
  if (msg.type === "match") return matchSummary(msg.match);
  if (msg.type === "challenge_resolved" && msg.match) return matchSummary(msg.match);
  return null;
}

export async function createConnectMcpServer(opts: McpServerOptions) {
  const connect = new ConnectClient({
    host: opts.host,
    displayName: opts.displayName ?? process.env.CONNECT_DISPLAY_NAME,
    relayUrl: opts.relayUrl ?? process.env.CONNECT_RELAY_URL,
  });

  await connect.start();

  const server = new McpServer({
    name: "connect",
    version: "0.1.0",
  });

  const text = (body: string) => ({
    content: [{ type: "text" as const, text: body }],
  });

  const json = (value: unknown, board?: string | null) => {
    const payload = JSON.stringify(value, null, 2);
    if (!board) return text(payload);
    return text(`${board}\n\n---\n${payload}`);
  };

  const boardFor = (match?: ChessState | null, snake?: SnakeState | null) => {
    const parts = [match ? matchSummary(match) : "", snake ? renderSnake(snake) : ""].filter(Boolean);
    return parts.length ? parts.join("\n\n") : null;
  };

  const withBoards = (value: unknown, match?: ChessState | null, snake?: SnakeState | null) =>
    json(value, boardFor(match, snake));

  server.tool(
    "connect_me",
    "Return this player's connect id, display name, host, and ENS name. Play stays in the IDE.",
    {},
    async () => json(connect.me()),
  );

  server.tool(
    "connect_set_player",
    "Save the wallet that deposits on the BNB Connect escrow.",
    {
      wallet: z.string().describe("0x wallet address"),
      chainId: z
        .number()
        .int()
        .describe("97 for BNB testnet, or 56 for BNB Chain"),
    },
    async ({ wallet, chainId }) => {
      if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error("Enter a 0x wallet address.");
      const payout = new Set([56, 97]);
      if (!payout.has(chainId)) {
        throw new Error("Use BNB testnet (97) or BNB Chain (56).");
      }
      await connect.setPlayer(wallet as `0x${string}`, chainId);
      return json({ me: connect.me(), bank: connect.relay.bank });
    },
  );

  server.tool(
    "connect_sync_deposit",
    "Read a USDC transfer into the play balance on the chain they picked. Play stays closed until that balance covers $0.05.",
    {},
    async () => {
      const msg = await connect.relay.syncDepositAsync();
      return json({ bank: msg.type === "bank" ? msg.bank : connect.relay.bank });
    },
  );

  server.tool(
    "connect_deposit",
    "Open the MetaMask page in the browser to approve USDT and deposit into ConnectEscrow on BNB testnet. When the deposit confirms, the signing wallet becomes the player wallet and the balance syncs.",
    {
      chainId: z.number().int().optional().describe("Deposit chain. Only 97 BNB testnet has the escrow today."),
    },
    async ({ chainId }) => {
      const page = depositPage(chainId ?? 97);
      if (!page) throw new Error("Deposit signing is on BNB testnet. The BNB Chain escrow is not deployed yet.");
      const returnTo = opts.host === "cursor" ? "Return to Cursor." : "Return to Claude Code.";
      const url = await startDepositPage(page, returnTo, (proof) => {
        void (async () => {
          await connect.setPlayer(proof.address, proof.chainId);
          // The escrow balance can lag the receipt by a block or two.
          for (let attempt = 0; attempt < 6; attempt += 1) {
            const msg = await connect.relay.syncDepositAsync().catch(() => null);
            if (msg?.type === "bank" && msg.bank.canPlay) return;
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        })().catch((err) => console.error("[connect] deposit sync failed:", err));
      });
      openInBrowser(url);
      return json({ url, escrow: page.escrow, chain: page.chainName, amount: `${page.label} USDT` });
    },
  );

  server.tool(
    "connect_claim",
    "Send the play balance to the saved wallet on the chain they picked.",
    {},
    async () => json(await connect.relay.claimBalanceAsync()),
  );

  server.tool(
    "connect_peers",
    "List live peers from the lobby. Nearby peers (same Wi-Fi via mDNS) are flagged.",
    {},
    async () => json({ peers: connect.peers(), nearby: connect.nearby.list() }),
  );

  server.tool(
    "connect_create_room",
    "Create a short room code so another connect can join you.",
    {},
    async () => {
      const room = await connect.createRoom();
      return json({ room });
    },
  );

  server.tool(
    "connect_join_room",
    "Join a room by its short code.",
    { code: z.string().describe("Room code, e.g. AB12") },
    async ({ code }) => {
      const room = await connect.joinRoom(code);
      return json({ room });
    },
  );

  server.tool(
    "connect_ping",
    "Send a short ping to another connect in the same room. Proves the connection.",
    {
      to: z.string().describe("Target connect id (conn_...)"),
      text: z.string().default("hello").describe("Short message"),
    },
    async ({ to, text: pingText }) => {
      const message = await connect.ping(to as `conn_${string}`, pingText);
      return json({ message });
    },
  );

  server.tool(
    "connect_poll",
    "Poll for peers, room, pings, challenges, the chess match, and the snake arena. Includes an in-IDE board when a game is active.",
    {},
    async () => {
      const poll = connect.poll();
      return withBoards(
        {
          ...poll,
          snakeBoard: poll.snake ? renderSnake(poll.snake) : null,
        },
        poll.match,
        poll.snake,
      );
    },
  );

  server.tool(
    "connect_next",
    "Enter the chess pairing queue. The first player waits. When another player also enters, the relay starts a match immediately. A call during a live match resigns that match.",
    {},
    async () => {
      await connect.relay.nextAsync();
      const match = connect.match();
      let legalMoves: string[] = [];
      if (match && match.status !== "finished") {
        try {
          legalMoves = legalUci(match.fen);
        } catch {
          legalMoves = [];
        }
      }
      return withBoards(
        {
          seeking: connect.relay.seeking,
          waiting: connect.relay.waiting,
          drawing: connect.relay.drawing,
          match,
          legalMoves,
        },
        match,
        null,
      );
    },
  );

  server.tool(
    "connect_challenge",
    "Challenge a peer in your room to a chess match inside the IDE. Optional stake in wei.",
    {
      to: z.string().describe("Target connect id"),
      stakeWei: z.string().optional().describe("Stake in wei, default 0"),
    },
    async ({ to, stakeWei }) => {
      const msg = await connect.relay.challengeAsync(
        to as `conn_${string}`,
        stakeWei ?? "0",
      );
      return json(msg);
    },
  );

  server.tool(
    "connect_respond",
    "Accept or decline an incoming chess challenge. Accepting shows the board in this IDE.",
    {
      challengeId: z.string(),
      accept: z.boolean(),
    },
    async ({ challengeId, accept }) => {
      const msg = await connect.relay.respondChallengeAsync(challengeId, accept);
      return json(msg, boardFromMessage(msg));
    },
  );

  server.tool(
    "connect_rematch",
    "Ask the opponent from the finished chess or flappy game for a rematch. A new game starts when both players ask. The updated play balance stays claimable.",
    { game: z.enum(["chess", "flappy"]) },
    async ({ game }) => {
      await connect.relay.rematchAsync(game);
      return json({
        rematch: connect.relay.rematch,
        match: connect.match(),
        flappy: connect.relay.flappy,
        bank: connect.relay.bank,
        seeking: connect.relay.seeking,
      });
    },
  );

  server.tool(
    "connect_flappy_join",
    "Enter the flappy pairing queue. The first player waits. When another player also enters, both fly the same course on their own machines. The relay only compares the final scores.",
    {},
    async () => {
      const msg = await connect.relay.flappyJoinAsync();
      return json({ flappy: msg.type === "flappy" ? msg.flappy : null });
    },
  );

  server.tool(
    "connect_flappy_score",
    "Report this player's finished flappy score. The relay compares it with the other player's score once both have finished.",
    {
      contestId: z.string(),
      score: z.number().int().nonnegative(),
    },
    async ({ contestId, score }) => {
      const msg = await connect.relay.flappyScoreAsync(contestId, score);
      return json({ flappy: msg.type === "flappy" ? msg.flappy : null });
    },
  );

  server.tool(
    "connect_snake_join",
    "Join the snakes arena. Omit the room code to enter the shared OPEN arena with everyone else who did the same. Pass a code to start or join a private room. The second player starts a 90 second round.",
    {
      code: z
        .string()
        .optional()
        .describe("Optional room code. Omit to join the shared arena."),
    },
    async ({ code }) => {
      const msg = await connect.relay.snakeJoinAsync(code);
      const snake = msg.type === "snake" ? msg.match : null;
      return withBoards(msg, null, snake);
    },
  );

  server.tool(
    "connect_snake_steer",
    "Set your snake's heading. The arena keeps moving on the relay. You cannot reverse 180 degrees. Hold boost to move twice as fast while longer than 10; boosting sheds tail pellets.",
    {
      dir: z.enum(["up", "down", "left", "right"]).describe("New heading"),
      boost: z.boolean().optional().describe("Speed boost. Costs length while you are long enough."),
      matchId: z.string().optional().describe("Snake match id. Defaults to the current arena."),
    },
    async ({ dir, boost, matchId }) => {
      const id = matchId ?? connect.snake()?.matchId;
      if (!id) throw new Error("No snake match. Call connect_snake_join first.");
      const msg = await connect.relay.snakeSteerAsync(id, dir as SnakeDir, boost ?? false);
      const snake = msg.type === "snake" ? msg.match : null;
      return withBoards(msg, null, snake);
    },
  );

  server.tool(
    "connect_snake_leave",
    "Leave the snake arena. If a round is live and you were the opponent, the other player wins.",
    {},
    async () => {
      const msg = await connect.relay.snakeLeaveAsync();
      const snake = msg.type === "snake" ? msg.match : connect.snake();
      return withBoards(msg, null, snake);
    },
  );

  server.tool(
    "connect_move",
    "Play a chess move as SAN (e4, Nf3, O-O, e8=Q) or UCI (e2e4, e7e8q). Returns the updated board.",
    {
      matchId: z.string(),
      uci: z.string().describe("SAN or UCI move, such as e4 or e2e4"),
    },
    async ({ matchId, uci }) => {
      const fen = connect.match()?.fen;
      const normalized = fen ? toUci(fen, uci) : uci.trim();
      const msg = await connect.relay.moveAsync(matchId, normalized);
      return json(msg, boardFromMessage(msg));
    },
  );

  server.tool(
    "connect_resign",
    "Resign the active chess match.",
    { matchId: z.string() },
    async ({ matchId }) => {
      const msg = await connect.relay.request("match", () =>
        connect.relay.resign(matchId),
      );
      return withBoards(msg, msg.type === "match" ? msg.match : null, null);
    },
  );

  const shutdown = () => {
    connect.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, connect };
}

export async function runConnectMcp(opts: McpServerOptions): Promise<void> {
  const { server } = await createConnectMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
