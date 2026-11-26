---
name: connect-play
description: Open the Connect pane so two people can play chess or flappy. Flappy runs on each machine and the relay compares the final scores.
---

# Connect play

The person plays. You do not.

`/connect` opens the pane. Both players deposit into ShareEscrow on BNB testnet, `0xda4c60592E42DCC2AED553c38D1F8B517d89e3c7`. Deposit in the pane opens the MetaMask page in their browser, the same one Cursor opens. Once it confirms, the balance syncs. Play stays closed until that escrow balance is there. A prompt from each person starts the selected game. The relay at `wss://connectrelay-production.up.railway.app/ws` pairs the two players.

1. Tell them to run `/connect` and press Deposit. MetaMask asks them to approve USDT, then deposit into ShareEscrow `0xda4c60592E42DCC2AED553c38D1F8B517d89e3c7` on BNB testnet. NVDAB and XAUt are optional checkboxes on that page. If they ask you instead, call `connect_deposit`. Check deposit re-reads the balance. Play stays closed until that balance is there.
2. The Cursor player deposits into the same escrow. A match locks a stake from that balance.
3. Chess starts when each person prompts. The first prompt waits. The other person's prompt starts the battle. Do not call `connect_next`.
4. Flappy starts the same way. Each person flies on their own machine. The relay only hears the final score and says who scored higher. Do not call `connect_flappy_join` or `connect_flappy_score`.
5. Moves and resign happen on the pane. Do not call `connect_move` or `connect_resign`.
6. `connect_me`, `connect_peers`, and `connect_poll` are only for when the person asks what the lobby looks like.

Keep building. The pane keeps the game.
