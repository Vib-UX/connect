# Connect

Two players deposit USDT once into `ConnectEscrow`. The relay locks a stake for each match, decides the winner, and the contract pays that player's balance.

The contract and the testnet record are in [contracts/README.md](contracts/README.md). The relay is `relay/`.

```bash
pnpm install
pnpm --filter @connect/relay test
pnpm --filter @connect/relay dev
```

On BSC testnet a deposit is 0.1 USDT and a match locks 0.001 USDT. Set `CONNECT_ESCROW_ADDRESS`, `CONNECT_ESCROW_CHAIN_ID=97`, and `ESCROW_SETTLER_PRIVATE_KEY` before starting the relay. See `.env.example`.
