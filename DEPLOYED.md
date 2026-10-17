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

Latest upgrade (2026-10-17): orphaned sell fee sweep (SECURITY_REVIEW.md L-4). Production build md5 `92d28ef47fa741fe88dfcbbad987d6fd`, verified byte for byte against the program account.
