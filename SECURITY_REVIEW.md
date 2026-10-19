# MemeMarkets security review

Scope: `programs/mememarkets/src/lib.rs` (Anchor 0.31.1). Reviewed line by line on 2026-10-16 (version 1) and again on 2026-10-17 (version 2, share trading, second reviewer pass). This is an internal review by the developer tooling, not an independent audit.

Severity scale: Critical (direct theft), High (theft or permanent lock under a realistic condition), Medium (loss or lock that needs a privileged or unusual action), Low (hardening), Info (design notes, no code change).

## Summary

No path was found that lets a bettor take more than they are owed, take another user's funds, or claim twice. The vault solvency math holds: each winner payout is floored, the fee is floored, and their sum is at most the pool (unit tested and asserted in the integration tests). The admin cannot withdraw from a vault.

Six issues were fixed (1 High, 1 Medium, 4 Low). A few items are recorded as design notes.

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| H-1 | High | `initialize` can be front run by anyone after deploy | Fixed |
| M-1 | Medium | Admin can lock all claims by setting a huge dispute window, and dispute window changes hit live markets | Fixed |
| L-1 | Low | `set_admin` accepts the zero key | Fixed |
| L-2 | Low | `initialize` accepts a mint that is not 6 decimals | Fixed |
| L-3 | Low | Winners on a very lopsided pool could receive less than their stake | Fixed |
| L-4 | Low | (v2) Sell fees on a side everyone cashed out of were stuck forever | Fixed |
| I-2 | Info | Any bettor can freeze payouts with a dispute | No change (README behavior) |
| I-3 | Info | Rounding dust and account rent stay locked forever | No change |
| I-4 | Info | Min and max bet are read live from config, not snapshotted | No change |
| I-5 | Info | Admin trust, USDC freeze authority, upgrade authority | No change |
| I-6 | Info | `set_admin` is one step | No change, use Squads |

## Findings

### H-1 (High): initialize could be front run. Fixed.
`initialize` only required some signer. The config PDA has a fixed seed, so the first caller after deploy wins. An attacker watching for the deploy could initialize first, becoming admin (decides every outcome) and pointing `fee_vault` at their own token account, with an arbitrary `usdc_mint`. The README said to "call it in the same breath as the deploy", which is not an on chain guarantee.

Fix: `Initialize` now takes `program` and `program_data` and requires `program_data.upgrade_authority_address == Some(admin)`. Only the upgrade authority can initialize. Test: "initialize: rejects a signer that is not the upgrade authority".

### M-1 (Medium): dispute window could lock claims indefinitely. Fixed.
`set_limits` accepted any `dispute_secs >= 0`, and `resolve_market` read `dispute_secs` from config at resolve time. A bad or compromised admin could set, for example, 100 years and then resolve: `claim` and `collect_fees` require `now >= dispute_ends`, and `emergency_void` only covers Open markets or disputed markets, so funds would be locked with no recovery. The admin could also set it to 0 just before resolving a live market to skip the dispute window that bettors expected.

Fix: `dispute_secs` is capped at `MAX_DISPUTE_SECS = 7 days` in both `initialize` and `set_limits`, and it is copied into each market (`Market.dispute_secs`) at creation, like the fee. `resolve_market` uses the market's value. This adds one `i64` field to `Market` (the account was never deployed, so there is no migration). Tests: "rejects a dispute window over 7 days", "dispute window is snapshotted at creation".

### L-1 (Low): set_admin accepted the zero key. Fixed.
Setting admin to `Pubkey::default()` would remove admin powers forever. No funds would be lost (Pending markets can be cancelled by the creator, Open and disputed markets fall to `emergency_void`), but every market would wait 14 days. Fix: `require!(new_admin != Pubkey::default())`.

### L-2 (Low): any mint accepted at initialize. Fixed.
All amounts assume 6 decimals. `initialize` now requires `usdc_mint.decimals == 6`. Combined with H-1 this prevents a wrong mint being configured.

### L-3 (Low): winners could get less than their stake. Fixed.
The original payout was stake / winning pool x total x 0.99. If the losing pool was under about 1 percent of the winning pool, total x 0.99 was less than the winning pool, so a winner could win and still lose money. Fix: fee = min(total x fee_bps / 10000, losing pool), and winner payout = stake + stake / winning pool x (losing pool - fee). A winner always gets at least their stake back, and the fee is unchanged whenever the losing pool covers it. Tests: unit test `lopsided_pool_winners_never_get_less_than_stake` and integration test "fee is capped at the losing pool and every winner gets at least their stake" (5 USDC vs 1490 USDC).

### L-4 (Low, version 2): orphaned sell fees. Fixed.
Every cash out leaves its 1% fee in that side's reserve. If every holder of a side cashed out, that side had zero shares but a nonzero reserve. On a Void or Rejected market, refunds are per side by shares, so nothing could reach that reserve. On a Resolved market where both sides had emptied out, `payout_for` returned 0 for everyone and `fee_for` returned 0, so the whole pot was stuck. Small amounts (fees only), but permanently locked.

Fix: `collect_fees` now also works on Void and Rejected markets and sweeps the reserve of any side with zero shares (`orphaned_for`). On a Resolved market where neither side has holders, `fee_for` returns the whole pot. Both paths are unit tested and covered by the integration tests "void: the sold out side's retained fees go to the platform", "resolved with nobody holding either side" and "rejected market with no cash outs has nothing to sweep", and were run live on devnet (DEVNET_SMOKE_TEST.md).

### I-2: dispute griefing
Any wallet with a position (min 5 USDC) can dispute once, which freezes claims until the admin settles. If the admin is absent, `emergency_void` refunds everyone 14 days after the dispute window ends. Bounded and documented, no change.

### I-3: dust and rent
Rounding dust (a few base units per market) remains in each vault, and market, vault and position accounts are never closed, so their rent stays locked. No user funds of note are affected. A future `close_market` after all claims could return rent.

### I-4: min and max are live
`buy_shares` checks `config.min_bet` and `config.max_bet` at trade time, so admin changes apply to open markets. This cannot move funds, only block or allow new buys. Fee, dispute window and curve are the values copied into each market.

### I-5: trust assumptions
- The admin decides outcomes. A compromised admin can resolve wrongly. The dispute window plus a Squads multisig admin are the mitigations.
- Circle USDC has a freeze authority. If Circle froze a vault, that market's funds would be stuck. Outside the program's control.
- The program is upgradeable. Whoever holds the upgrade authority can replace the code, which overrides every guarantee above. See DEPLOYED.md.

### I-6: one step admin transfer
A typo in `set_admin` hands control to a wrong key. L-1 blocks the zero key only. Moving to a Squads multisig once, carefully, is the plan. A two step propose and accept would be safer if admin changes become routine.

## Change after review: early Yes resolution with lock (2026-10-16)
Markets now resolve Yes as soon as the target is touched, not only at the deadline. To stop late bettors from betting on an outcome that is already known, early Yes requires the market to be Locked first:
- `lock_market` (admin): Open to Locked, bets fail immediately. Lock time stored in `resolved_ts` (no layout change, so existing accounts stay valid).
- `unlock_market` (admin): Locked to Open, only before the deadline.
- `resolve_market`: Yes before the deadline only from Locked. No and Void only after the deadline.
- `void_market` covers Locked. `emergency_void` covers Locked 14 days after the lock or the deadline, whichever is first.
- `Locked` was appended last in `MarketStatus` so stored status bytes keep their meaning.
Residual risk: the window between the price touching the target and the lock transaction landing is still open to a fast bettor. The resolver must watch prices continuously and lock fast. The admin can also lock and resolve Yes at will, which is the same admin trust as before.

## Change after review: resolver role (2026-10-16)
A second key, the resolver, can call only `lock_market`, `unlock_market` and `resolve_market`. It is stored in its own PDA `["resolver"]` (`ResolverConfig`) so the existing Config layout is unchanged. `set_resolver` is admin only, and the zero key turns the resolver off. The resolver cannot approve, reject, void, settle disputes, pause, change limits, change admin or change the resolver. This lets the price watcher server hold a limited key instead of the admin key. Residual risk: a leaked resolver key can still resolve markets wrongly until the admin replaces it. The dispute window and a fast admin response are the mitigation.

## Version 2: share trading with cash out (2026-10-17)
Betting changed from a single pool to two price curves (one per side). New program ID, so no data migration. What changed and how it was checked:
- **Curve:** price(x) = base + x / depth per side. Buys are charged the area under the curve rounded up, sells pay the area rounded down, so rounding always favors the pool. Unit tests show a buy followed by an immediate sell never makes money, and that the side's reserve always covers selling the entire supply after any sequence of buys and sells.
- **Sell fee:** the market fee (1%) is taken on every cash out and stays in that side's reserve, so it ends up with the winners. It also makes churning and self trading cost money.
- **Payouts:** winners split the whole pot (both reserves) minus min(1% of pot, losing reserve), pro rata by shares. If nobody holds the winning side, the other side's holders split the whole pot with no fee. Void and Rejected refund each side's holders pro rata from that side's reserve. All are floor rounded, so the sum never exceeds the vault (unit tested and asserted in every integration test).
- **Trading windows:** buy and sell only while Open and before the deadline. Lock stops both. Pause stops both plus new markets. Claims always work.
- **Guards:** slippage limits on every buy (`min_shares_out`) and sell (`min_usdc_out`). Max per wallet is on cost basis. One side per wallet at a time.

New risks to know about:
- **Sandwiching.** Someone who sees a large pending buy can buy just before it and sell just after. The 1% sell fee and the slippage limits reduce this, and the UI should default to a tight (about 2%) slippage tolerance.
- **Late buyers can lose even when right.** A late buyer pays a higher price, so their share of the pot can be less than they paid when the other side is small. This is how the product works. The UI should show "payout if you win" before every buy.
- **Void refunds are pro rata, not cost based.** If someone cashed out at a profit before a void, the remaining holders on that side get back less than they paid. Paying everyone their full cost could make the vault insolvent.
- **Curve parameters** are admin set within bounds, and each market keeps the curve it was created with.

## Change: automatic payouts with claim_for (2026-10-18)
`claim_for` lets any signer pay a position's payout or refund. It shares one code path (`pay_out`) with `claim`, so the amount, timing (after the dispute window, not while disputed) and the single `claimed` flag are identical. The destination must be a USDC token account whose owner is the position's user (`token::authority = owner`), and the position is derived from `["position", market, owner]` with `position.user == owner`, so a caller can neither redirect funds nor pay from someone else's position. The caller only pays the transaction fee. Tested: exact amounts for winners, losers and void refunds, caller balance unchanged, payout into the caller's own account rejected (`ConstraintTokenOwner`), mismatched owner and position rejected (`ConstraintSeeds`), double payment rejected through both paths, and calls before resolution or inside the dispute window rejected. Run live on devnet (DEVNET_SMOKE_TEST.md). Note: if a holder closed their USDC account, `claim_for` fails for them and they claim manually.

## Change: seed is a prize pot, creator and admin cannot trade (2026-10-19)
- `create_market` no longer buys shares. The seed is split evenly into the outcome reserves and recorded in the `["bonus", market]` account, so every market starts at even odds and the creator has no position.
- `buy_shares` rejects the market's creator and the config admin (`CreatorCannotTrade`). The admin resolves outcomes, so keeping it out of every market removes a conflict of interest; creators cannot front run their own markets.
- `reject_market` and `cancel_pending` refund the whole vault to a USDC account owned by the creator. A Pending market can only hold the seed (no trades, and `add_bonus` is now Open only), so the refund is exactly the seed.
- Tested: even split for 2 and 3 outcomes, admin seed 0, creator and admin buy rejected, reject and cancel refunds exact and only to the creator's own account, add_bonus rejected while Pending. 25 integration test groups pass.

## Version 3 (2026-10-19)
New program (account layouts changed). What changed and how it was checked:
- **2 or 3 outcomes.** Reserves and share supplies are arrays; every outcome index is checked against `outcome_count` (`BadSide`, `BadParams`). Winners split every outcome's reserve minus the fee; the fee is capped at the money on the losing outcomes. If nobody holds the winning outcome, every holder gets their own outcome's reserve back and only reserves nobody holds go to the platform. Unit tested for 2 and 3 outcomes, and asserted after every step on chain.
- **Early resolution.** Only from Locked. A 2 outcome market can only resolve Yes early (No means "not by the deadline"); a 3 outcome market can resolve any outcome early. Void only after the deadline (or by the admin with `void_market`).
- **Open creation and Verified.** `set_creation` (admin) controls whether user markets need approval. Admin created markets are always Open and Verified with no creator share. `set_verified` is admin only and display only.
- **Creator fee share.** Copied into each market at creation. `collect_fees` sends the platform part and keeps the creator part in the vault as `creator_fee_owed`; `claim_creator_fee` pays it once, only to a USDC account owned by `market.creator`. The vault stays solvent: the test suite counts the unpaid creator part as owed.
- **Rules hash.** `rules_hash` (sha256 of the rules text) is fixed at creation, so the wording users bet on cannot be changed later without it showing.
- **Residual risks:** 3 outcome markets are resolved by the admin, not the watcher, so they carry the same admin trust as before. With open creation on, anyone can create markets on any token, including thin ones that can be pushed to a target; the site should apply minimum liquidity and market cap rules and the admin can void.

## Checks that passed (no issue found), version 2 pass
- Signer checks: every admin instruction uses `has_one = admin` on the config PDA. `lock`, `unlock` and `resolve` accept the admin or the key stored in `ResolverConfig` (zero key disabled). `cancel_pending` uses `has_one = creator`. `claim` and `sell_shares` pay only a token account owned by the signer, with the config mint.
- PDA seeds: config `["config"]`, resolver `["resolver"]`, market `["market", id le]`, vault `["vault", market]`, position `["position", market, user]`. All verified with stored bumps. `Account<>` checks owner and discriminator.
- Vault drain: vaults only move out through `sell_shares` (bounded by `sell_value` minus fee, which the reserve always covers), `claim` and `claim_for` (one shared path, bounded by `payout_for` or `refund_for`, once per position, only to the owner's account) and `collect_fees` (once). Fee vault address is pinned in config. While trading, vault balance always equals `yes_reserve + no_reserve` (asserted after every trade in the integration tests).
- Double claim: `claimed` is set before the transfer, and the position PDA is unique per user and market. Fee uses `fee_collected`.
- init_if_needed: the position is seeded by the signer's key and paid by the signer, so nobody can create or reset another user's position. A position is never closed, so it cannot be re-initialized. A sell on a fresh position fails before any state change.
- Status machine: trades only on Open before the deadline. Lock from Open; unlock from Locked before the deadline. Early Yes only from Locked. No and Void only after the deadline. Claims only on Void, Rejected, or Resolved after the window and not disputed. Disputes only before `dispute_ends`, and `settle_dispute` sets `dispute_ends = now` so a market cannot be disputed twice.
- Stuck funds: Pending (creator cancels or admin rejects), Open or Locked (admin resolves or voids, resolver resolves, else emergency_void after 14 days), disputed (admin settles, else emergency_void), Resolved (claims open once the capped window ends), orphaned sell fees (swept by collect_fees, L-4). No state is terminal with funds locked.
- Overflow: all arithmetic is checked or done in u128. Curve bounds keep every intermediate product inside u128 for any reachable supply. `overflow-checks = true` in release.
- Pause: `create_market`, `buy_shares` and `sell_shares` check `paused`. Claims, refunds and fees are unaffected.
- Build: the deployed binary is reproducible. A fresh `./scripts/build.sh` gives the same md5 as the bytes on devnet, and `scripts/mainnet.sh` refuses to deploy anything else.

## Testing
- `cargo test`: 15 unit tests pass (v3) (curve math, rounding, solvency, payouts, refunds, sweeps, overflow bounds).
- `anchor test --skip-build` on the short-time test build (`./scripts/build.sh test`): 24 integration test groups pass on v3, each with many checks. Every instruction is covered. Every buy, sell, claim and fee amount is checked against an independent bigint copy of the math. Vault solvency is asserted after every step, and total withdrawn plus fees never exceed total deposited.
- The short-time build only changes `MIN_DURATION` (2 s) and `EMERGENCY_DELAY` (6 s) behind the `short-time` cargo feature. The deployed binary is built without it.
