# MemeMarkets program

Anchor program (Solana) for yes or no prediction markets on memecoins, traded as shares with cash out. All money is USDC. Each market has its own vault PDA that only the program can move. No person or private key can take the money.

Version 2 (share trading). The version 1 pool design is archived in `archive/v1-pool/`.

## $PRED token
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

## How a market works
1. Anyone proposes a market ("will token X reach a $5M market cap by Friday?") and buys the first shares. The market waits in Pending until the admin approves it.
2. Each side (Yes, No) has its own price. Buying a side pushes its price up, selling pushes it down. Early buyers get more shares per USDC.
3. Anyone can cash out (sell shares back) any time while the market is Open. They get the current value minus a 1% fee that stays in the pot.
4. When the target is hit, the watcher (resolver key) locks the market, confirms the price, and resolves Yes. If the deadline passes without a hit, it resolves No.
5. Payouts open after the dispute window (5 minutes by default, max 7 days). The winning side's shares split the whole pot (both sides) minus the 1% platform fee, pro rata by shares. Losing shares get 0. The watcher then pays every holder automatically (`claim_for`); holders can also press Claim themselves.

## Instructions
Users:
- `create_market(token_mint, metric, direction, target, target_decimals, end_ts, side, seed_amount, min_shares_out)`
- `buy_shares(side, usdc_in, min_shares_out)` and `sell_shares(shares, min_usdc_out)`: only while Open and before `end_ts`. `min_*` are slippage guards.
- `cancel_pending()`: the creator pulls a Pending market.
- `dispute_market()`: any holder, during the dispute window. Freezes payouts until the admin settles.
- `claim()`: payout, or refund on Void or Rejected. Pays the signer's own USDC account only.
- `claim_for()`: automatic payout. Anyone (normally the price watcher) can send a holder's payout or refund to that holder's own USDC account. The program only accepts a token account owned by the position's owner, so the caller cannot redirect the money. Same timing rules as `claim`, and a position can only be paid once by either path.
- `collect_fees()`: anyone, once per market. On a Resolved market after the window: the platform fee. On a Void or Rejected market: retained sell fees of any side nobody holds any more (nothing else can reach them).
- `emergency_void()`: anyone, 14 days after `end_ts` if never resolved, 14 days after a lock that was never resolved, or 14 days after `dispute_ends` if a dispute was never settled. Everyone is refunded.

Admin:
- `approve_market`, `reject_market`, `void_market` (Open or Locked), `settle_dispute(result)`
- `set_paused` (stops new markets, buys and sells; claims always work), `set_limits(fee_bps, min_bet, max_bet, dispute_secs)`, `set_curve(base, depth)`, `set_resolver(key)`, `set_admin(key)`
- `initialize(fee_bps, min_bet, max_bet, dispute_secs)`: once, by the program upgrade authority only.

Admin or resolver:
- `lock_market` (Open to Locked, stops trading), `unlock_market` (before `end_ts` only), `resolve_market(result, final_value)`. Yes before the deadline only from Locked. No and Void only after the deadline.

## Math
- Price per share on a side: `base + supply / depth` (USDC base units). Default base 0.10 USDC, depth 10,000 (each 1,000 shares bought add 0.10 USDC).
- Buys are charged the exact area under the curve, rounded up. Sells pay the area, rounded down, minus the market fee. Rounding always favors the pool, so a side's reserve always covers selling every share.
- Fee on resolution: `min(pot x fee_bps / 10000, losing reserve)`. Winners get `shares / winning shares x (pot - fee)`. If nobody holds the winning side, the other side's holders split the whole pot with no fee. If nobody holds either side, the platform takes the leftover (it is only retained sell fees).
- Void or Rejected: each side's holders split that side's reserve by shares.
- Payouts plus fees can never exceed the vault (unit tested and asserted after every step of the integration tests).

## Rules enforced on chain
- Fee, dispute window and curve are copied into each market at creation. Later config changes apply to new markets only. Min buy and max per wallet (on cost basis) apply to new trades.
- One side per wallet per market at a time. Sell everything to switch.
- `fee_bps` max 500, `dispute_secs` max 7 days, deadline 1 hour to 90 days, USDC mint must have 6 decimals.

## Trust model
- The admin key decides outcomes, and the resolver key (for the price watcher server) can only lock, unlock and resolve. Neither can withdraw from a vault. A bad or hacked key could resolve a market wrongly; the dispute window and a Squads multisig admin are the mitigations.
- The program is upgradeable. Whoever holds the upgrade authority can replace the code. Move it to a multisig or revoke it after an audit.
- Circle USDC has a freeze authority. A frozen vault would be stuck. Outside the program's control.

## Status
- See SECURITY_REVIEW.md for the internal review, fixes and residual risks.
- Build: `./scripts/build.sh` (platform tools v1.52). Test build: `./scripts/build.sh test`, then `anchor test --skip-build`.
- 14 unit tests and 28 integration test groups pass on a local validator. Live devnet runs are logged in DEVNET_SMOKE_TEST.md.
- NOT independently audited. Before real money: audit, Squads multisig as admin and upgrade authority, low caps, legal check.

## PDAs
- config: `["config"]`
- resolver_config: `["resolver"]`
- market: `["market", market_id as u64 little endian]`. Next id is `config.market_count`.
- vault: `["vault", market pubkey]`
- position: `["position", market pubkey, user pubkey]`

## Deploy
- Devnet: `./scripts/build.sh`, `solana program deploy target/deploy/mememarkets.so --program-id target/deploy/mememarkets-keypair.json -u devnet`, then `scripts/devnet-v2.ts setup`.
- Mainnet: `scripts/mainnet.sh` walks through balance, deploy (verifies the binary before and after), init (fee vault, resolver key, paused), unpause, and refund. See DEPLOYED.md for live addresses.
- Addresses: Circle USDC is `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` on mainnet and `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` on devnet.

## Rent and fees users should expect
A small SOL network fee on every transaction. The first trade in a market creates a position account (about 0.002 SOL rent, not returned). Creating a market costs about 0.01 SOL rent.
