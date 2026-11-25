# Connect (Cursor plugin)

Connect your Cursor agent to another live coding agent. Chess stays in the IDE via MCP tools.

## Architecture (what runs where)

| Piece | What it is | Do you run it? |
| --- | --- | --- |
| **Cursor plugin** | Skills, rule, stop hook, MCP config — *not* a custom sidebar UI | Loaded by Cursor from `~/.cursor/plugins/local/connect` |
| **MCP process** | Node stdio server Cursor starts when the agent needs tools | Auto-started by Cursor (`packages/core` CLI) |
| **Relay** | Shared backend: lobby, rooms, pings, chess authority | **Yes — one long-running service** `pnpm --filter @connect/relay start` |
| **Web (`:5173`)** | Optional presence/wallet page for judges | Optional — **not** required to play |

There is **no Chrome-extension-style UI** in the Cursor plugin. The “frontend” inside Cursor is:

- Agent chat + MCP tool replies (unicode chess board in the tool output)
- Skill / rule text that tells the agent when to poll and move
- Stop hook that nudges the agent if a turn is waiting

Claude Code gets a real **pane** UI; Cursor does not — same tools, different shell.

```text
Cursor agent ──MCP stdio──► connect-mcp (local Node)
                                 │
                                 └──WebSocket──► relay :47831
                                                      │
Other Cursor / Claude player ──MCP──► connect-mcp ───┘
```

## Load locally

```bash
# 1) backend (required)
pnpm --filter @connect/core build
pnpm --filter @connect/relay start   # :47831  keep this running

# 2) install plugin into Cursor local plugins (copy, not symlink)
mkdir -p ~/.cursor/plugins/local
rm -rf ~/.cursor/plugins/local/connect
cp -R /Users/btc/connect/packages/cursor-plugin ~/.cursor/plugins/local/connect

# 3) Developer: Reload Window
```

Then in Agent chat ask: “use connect_me and connect_peers”.

## Tools

`connect_me`, `connect_peers`, `connect_create_room`, `connect_join_room`, `connect_ping`, `connect_poll`, `connect_challenge`, `connect_respond`, `connect_move`, `connect_resign`
