# Changelog

## v3.1 (2026-10-27) Current
- Markets can now run up to 2 years (was 90 days), for long-range predictions.
- Devnet upgraded in place. Existing markets and positions are unchanged.

## v3 (2026-10-19)
- Markets with 2 or 3 outcomes. Winners split every other outcome's money.
- The creator's seed is split evenly across the outcomes and is not a bet, so markets start at even odds.
- The market creator and the admin cannot trade.
- Open creation switch for a staged rollout, Verified badge for official markets.
- Creator fee share: market creators earn part of the platform fee, paid automatically.
- Rules hash: the market wording is fixed on chain at creation.
- Rejected or cancelled markets refund the creator's seed right away.
- Deployed to devnet as `BGCcEd1X76oZ2yF9nRoun2gGGLJC3D59Z2XEJNJ6KmhZ`, on chain IDL published.

## v2.x (2026-10-17 to 2026-10-18)
- Share trading: each outcome has its own price curve, and anyone can cash out before the market locks.
- Automatic payouts (`claim_for`): winnings are sent to each holder's own wallet.
- Lock and early Yes resolution, a limited resolver key for the price watcher, 5 minute payout window.
- Sweep of retained sell fees on outcomes nobody holds.

## v1 (2026-10-16)
- Original pooled Yes/No markets with admin resolution, dispute window and 14 day emergency void.
- Internal security review: initialize front running fixed, dispute window capped and snapshotted, admin and mint checks.
