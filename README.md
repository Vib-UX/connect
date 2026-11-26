# Connect

Two players deposit USDT once into `ConnectEscrow`. The relay locks a stake for each match, decides the winner, and the contract pays that player's balance.

The contract and the testnet record are in [contracts/README.md](contracts/README.md). The relay is `relay/`.

```bash
pnpm install
pnpm --filter @connect/relay test
pnpm --filter @connect/relay dev
```

On BSC testnet a deposit is 0.1 USDT and a match locks 0.001 USDT. Set `CONNECT_ESCROW_ADDRESS`, `CONNECT_ESCROW_CHAIN_ID=97`, and `ESCROW_SETTLER_PRIVATE_KEY` before starting the relay. See `.env.example`.

## Share stakes

`ShareEscrow` takes any two share tokens. Each player deposits the stock they want to stake. Both sides name the same dollar size. At lock the contract reads each token's Atlas price and freezes the share count that equals that value. The match names the winner, and `settle` pays both frozen piles to that player, or returns each pile on a draw.

Nvidia against Tesla is one way to use it. In the clip each side stakes $100. Player A locks Nvidia: the feed is $200, so the escrow freezes 0.5 NVDAB. Player B locks Tesla: the feed is $400, so it freezes 0.25 TSLAB. Those piles are the same $100, and Chess or Flappy settles them.

![Each player locks a preferred stock, the escrow matches the dollar value, and the match settles it](contracts/docs/share-escrow-flow.gif)

The local proof reads the live feeds on a BNB mainnet fork and does not broadcast:

```bash
pnpm test:contracts:share:fork
```

Addresses, the `lock` and `settle` calls, and the fork command are in [contracts/README.md](contracts/README.md#shareescrow).
