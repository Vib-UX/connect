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

`ShareEscrow` is separate from the USDT escrow. Each player deposits the share token they prefer. Both sides name the same dollar size. Atlas decides how many shares that dollar size is. Chess or Flappy decides who receives both piles.

### Atlas workflow

1. The owner registers each token. `setSingleFeed` points it at a SingleFeed, which `lock` reads with `latestRoundData()`. `setMultiFeed` points it at a MultiFeed id, which `lock` reads with `fetchCompact` and [`FeedCodec.decode`](https://github.com/oracle-atlas/push-oracle-interfaces/blob/main/src/libraries/FeedCodec.sol).
2. Each player calls `deposit` with their own token. The contract does not swap one stock for the other.
3. The settler calls `lock` with one dollar amount, 18 decimals, for each side. The contract reads both feeds at that moment. A zero answer, or an update older than `maxPriceAge`, reverts. The share counts freeze on the bet.
4. The match names the winner. `settle` pays those stored counts and does not read Atlas again. `AWins` and `BWins` send both piles to that player. `Draw` returns each pile. After the settle deadline, `refund` returns each pile.

Nvidia against Tesla is one way to use it. In the clip each side stakes $100. Player A locks Nvidia: the feed is $200, so the escrow freezes 0.5 NVDAB. Player B locks Tesla: the feed is $400, so it freezes 0.25 TSLAB. Those piles are the same $100, and Chess or Flappy settles them.

![Each player locks a preferred stock, the escrow matches the dollar value, and the match settles it](contracts/docs/share-escrow-flow.gif)

On BSC testnet the live proof uses the NVDAB/USD and XAU/USD SingleFeeds. Those addresses are price feeds, so the test mints stand-in NVDAB and XAUt piles and registers them against the feeds. The deployed escrow is [`0xEB8B7C5105D95E08c09fcf067936e44222BF2A59`](https://testnet.bscscan.com/address/0xEB8B7C5105D95E08c09fcf067936e44222BF2A59), and the [source matches the bytecode](https://repo.sourcify.dev/contracts/full_match/97/0xEB8B7C5105D95E08c09fcf067936e44222BF2A59/).

The local fork reads those same feeds and does not broadcast:

```bash
pnpm test:contracts:share:fork
```

Feeds, the `lock` and `settle` transactions, and the fork command are in [contracts/README.md](contracts/README.md#shareescrow).
