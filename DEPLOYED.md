# MemeMarkets deployment

Version 2: share trading with cash out. Devnet.

| Field | Value |
|---|---|
| Cluster | Solana devnet |
| Program ID | `3B84AX7kyaGSMrxyKZrJBng4MQtirx9CF1G54yGGL1RM` |
| Config account | `CjxVcKCmSiEbHhkTZHMHk41nepxQ7mCwmKUA6rF8Qk5G` |
| Fee vault | `5uYzUnoieZNDSPvz6rxBn4FXCiAM4tJcpfsdG86SGiMQ` |
| USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Admin address | `7TPuntBHLRAyjBNKvMx24aKcXL9aGT2uaacUPJSWEMeF` |
| Upgrade authority address | `5K5eygxQLToM9TUt2VoWcummCvEpJyEL9A83d3nmGPkA` |
| Resolver (price watcher) | `EskbinsytGLYYrbHgCnKvkZoQGEF5AzgiWzETxYk21Ss` |

## Solscan (devnet)
- Program: https://solscan.io/account/3B84AX7kyaGSMrxyKZrJBng4MQtirx9CF1G54yGGL1RM?cluster=devnet
- Config account: https://solscan.io/account/CjxVcKCmSiEbHhkTZHMHk41nepxQ7mCwmKUA6rF8Qk5G?cluster=devnet
- Fee vault: https://solscan.io/account/5uYzUnoieZNDSPvz6rxBn4FXCiAM4tJcpfsdG86SGiMQ?cluster=devnet
- USDC mint: https://solscan.io/token/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU?cluster=devnet
- Admin: https://solscan.io/account/7TPuntBHLRAyjBNKvMx24aKcXL9aGT2uaacUPJSWEMeF?cluster=devnet
- Upgrade authority: https://solscan.io/account/5K5eygxQLToM9TUt2VoWcummCvEpJyEL9A83d3nmGPkA?cluster=devnet

The version 1 pool program (`EaYBtMWdemH7szKjdtiti6iLgRi6HDTdqpsyk7qDwh49`) was closed on devnet on 2026-10-17 after all its markets settled.

Latest upgrade (2026-10-18): automatic payouts (`claim_for`). Production build md5 `e9dc38193ac9a249d613e74f2c4dc862`, verified byte for byte against the program account. On chain IDL: `5e9bfNwLkJBJFH2aSVRUrbCPtfvDrEL7Msy6utnTovfe`.

## $PRED token (mainnet)
MemePredictions' project token, launched on pump.fun on 2026-10-18.

| Field | Value |
|---|---|
| Name / ticker | MemePredictions / $PRED |
| Contract address (mint) | `AwEvmmmsW26hSrcUcDxUbxyoybyireqTDYYxHhCpump` |
| Chain / standard | Solana mainnet, Token-2022 |
| Supply | 1,000,000,000 (6 decimals) |
| Mint authority | None (revoked, no more can be minted) |
| Freeze authority | None (no wallet can be frozen) |

- Creator fees from the token go toward seeding new prediction markets.
- $PRED is separate from this program. Markets are traded and paid out in USDC only; the program never touches $PRED.
- Links: [pump.fun](https://pump.fun/coin/AwEvmmmsW26hSrcUcDxUbxyoybyireqTDYYxHhCpump), [Solscan](https://solscan.io/token/AwEvmmmsW26hSrcUcDxUbxyoybyireqTDYYxHhCpump). Always check the contract address above before buying; anyone can make a token with the same name.
