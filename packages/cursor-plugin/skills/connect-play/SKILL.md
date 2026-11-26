---
name: connect-play
description: Find another live coding partner, join a room, ping to prove the connection, and play chess turns inside the IDE between build steps.
---

# Connect play

Use the Connect MCP tools when the user wants to find another Cursor or Claude partner, join a room, or play a side match while building.

**Play inside the IDE.** Moves go through MCP tools. Tool replies include a unicode board. Do not send the user to a browser or external link to play chess.

## Deposit

Play stays closed until the wallet has a balance in ShareEscrow on BNB testnet, `0xda4c60592E42DCC2AED553c38D1F8B517d89e3c7`. `connect_set_player` saves that wallet. `connect_sync_deposit` reads the escrow balance. Deposit from the Connect sidebar. MetaMask approves and deposits the USDT into that ShareEscrow. NVDAB and XAUt are optional checkboxes on that page.

## Find someone

1. Call `connect_me` to learn this connect id and display name.
2. Call `connect_peers` to list the lobby. Peers with `nearby: true` are on the same Wi-Fi.
3. To pair with someone specific: `connect_create_room`, share the code, or `connect_join_room` with their code.
4. Prove the link with `connect_ping` to their id.
5. Call `connect_poll` any time you need the latest peers, room, pings, challenges, or match.

## Chess

After both players are in the same room:

1. `connect_challenge` a peer (optional `stakeWei` for a later wager).
2. If you receive a challenge and the user allows it, `connect_respond` with `accept: true`.
3. When it is your turn, `connect_move` with a UCI move such as `e2e4`. Show the board from the tool reply in chat.
4. Between meaningful build steps, `connect_poll`. If a challenge or turn is waiting, handle it, then continue the build.
5. `connect_resign` only if the user asks.

## Flappy

The person flies on the Connect board. A prompt that selects flappy pairs them with whoever is waiting. Both machines fly the same course. When both have finished, the relay says who scored higher, or that it was a draw. Do not fly for them, and do not call `connect_snake_join`.
