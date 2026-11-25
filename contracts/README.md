# ConnectEscrow

One contract on BNB Chain holds a USDT balance per player. A player deposits once. Each chess or Flappy match locks a stake from that balance. The relay reports the winner, and the contract adds the pot to that player's balance.

On BSC testnet the deposit is 0.1 USDT and the stake is 0.001 USDT. Both use 18 decimals.

## BSC testnet (chain id 97)

| | Address |
|---|---|
| ConnectEscrow | [`0x2c77532f9b5E32D0E5f5BF2AF3B1B0b3484F3E54`](https://testnet.bscscan.com/address/0x2c77532f9b5E32D0E5f5BF2AF3B1B0b3484F3E54) |
| MockUSDT | [`0x27Ae80b8eE17ffbCFCf38469A018A942BC8f8Ba9`](https://testnet.bscscan.com/address/0x27Ae80b8eE17ffbCFCf38469A018A942BC8f8Ba9) |
| Settler | [`0xC04F807aC5D7963055e8827EAc37350703afdCfC`](https://testnet.bscscan.com/address/0xC04F807aC5D7963055e8827EAc37350703afdCfC) |

Source matches the deployed bytecode:

- [ConnectEscrow on Sourcify](https://repo.sourcify.dev/contracts/full_match/97/0x2c77532f9b5E32D0E5f5BF2AF3B1B0b3484F3E54/)
- [MockUSDT on Sourcify](https://repo.sourcify.dev/contracts/full_match/97/0x27Ae80b8eE17ffbCFCf38469A018A942BC8f8Ba9/)

### Transactions

- [Deploy MockUSDT](https://testnet.bscscan.com/tx/0x82873066029e32714a8beb109174bcbcb0e3d3411fc67074ddb095564da108cd)
- [Deploy ConnectEscrow](https://testnet.bscscan.com/tx/0x7b50648f956f36040416eb0b672af0cd4ab7772203d276e474af89c2235f32ac)
- [Mint 0.1 USDT to player A](https://testnet.bscscan.com/tx/0x4db63352d78b587bbfd870bb53245e21ea074c34e3ccfdfc7c0bb07939bbe811)
- [Mint 0.1 USDT to player B](https://testnet.bscscan.com/tx/0xc9158c487c5f0b9585632137447c0d8882e866a9db4244f2bcac9b6be8831250)
- [Player A wins 0.001](https://testnet.bscscan.com/tx/0x22a4d4b6d694cd86b64334f2c28d8bebe37e6c3bd2ccb8535a029514f100a555)
- [Player B wins 0.001](https://testnet.bscscan.com/tx/0x7185eb8e191c220932f3e17db2018a7f29d45dffb2c7dd27b6f296ce9493cff2)

Player A is `0xC144dEB94B6E27d903d4D0931A09A40A04f4A113`. Player B is `0x5278754c5d899B646a15f9BC481989272bA50B68`. After both results, each escrow balance is 0.1 USDT again.

## Tests

Install Foundry libraries once:

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
```

```bash
# Local escrow cases: one 0.1 deposit covers two 0.001 bets
forge test --match-path test/ConnectEscrow.t.sol

# Same flow on a BSC testnet fork. No faucet and no broadcast.
forge test --match-path test/ConnectEscrow.fork.t.sol -vv
```

From the repo root, `pnpm test:contracts` and `pnpm test:contracts:fork` run those two suites. The relay suite is `pnpm --filter @connect/relay test`.

## Deploy again

`ESCROW_SETTLER` is the address allowed to `lock` and `settle`. The key stays in the environment, not in git.

```bash
forge script script/DeployConnectEscrowTestnet.s.sol:DeployConnectEscrowTestnet \
  --rpc-url "$BNB_RPC_URL" \
  --private-key "$ESCROW_SETTLER_PRIVATE_KEY" \
  --broadcast \
  --legacy
```
