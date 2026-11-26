# Connect

P2P games inside an agentic session. Chess or Flappy. Each player deposits into ShareEscrow. Both sides lock the same dollar size. The relay game feed settles who is the winner.

This package is the session pane. `/connect` opens the multiplayer game. Pick Chess or Flappy, then prompt. The relay matchmakes the two live players. The person plays. The agent does not.

## Install

```bash
npm install -g @hlvuser/connect
claude --plugin-dir "$(connect-claude-mod)"
```

`connect-claude-mod` prints the folder of that global package. The session loads the plugin from it.

From a checkout of this repo:

```bash
pnpm --filter @connect/core build
claude --plugin-dir ./packages/claude-mod
```

## Play

1. `/connect`
2. Press Deposit. The sign page mints mock USDT when the account is short, then approves and deposits it into ShareEscrow `0xda4c60592E42DCC2AED553c38D1F8B517d89e3c7` on BNB testnet. NVDAB and XAUt are optional on that page and mint the same way. Play stays closed until that balance is there.
3. Pick Chess or Flappy.
4. Prompt. The first prompt waits. The other player's prompt starts the round.
5. Chess is in the pane. Click a piece and then a square, use the arrows and Enter, or type `e4` / `e2e4`.
6. Flappy flies on your machine. Click the board, then space, ↑, `w`, or Enter flaps. `p` pauses. The course is the same for both players. Nothing is sent until you crash. The relay game feed settles who is the winner.
7. `/connect stop` closes the pane and leaves the game on the relay.

`claude plugin validate ./packages/claude-mod` lists the hooks.

## Config

The display name and relay URL are read when the MCP process starts. The relay is `wss://connectrelay-production.up.railway.app/ws`. Set `display_name` and `relay_url` before that process starts. `pieces` is `unicode` or `letters`. `columns` is the docked pane width, 30–100, default 60.

## What the pane does

- Chess is the battle. Your side is at the bottom. The first prompt enters the relay queue. The other player's prompt starts the match. A later prompt does not search again, because a new search resigns the live game.
- Flappy is local. Both players get the same seed and fly on their own. The relay game feed settles who is the winner.
