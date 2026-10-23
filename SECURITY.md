# Security policy

MemePredictions holds user funds in on-chain vaults, so we take security reports seriously.

## Reporting a vulnerability

Please report privately. Do not open a public issue.

- **Preferred:** GitHub private vulnerability reporting. Go to the **Security** tab of this repository and click **Report a vulnerability**.
- **Or:** send a DM to [@MemePredictfun](https://x.com/MemePredictfun) on X and we will move to a private channel.

Please include the program ID, the instruction involved, steps to reproduce and the impact you expect. We aim to reply within 48 hours.

## Scope

- The Anchor program in `programs/mememarkets` (devnet program `BGCcEd1X76oZ2yF9nRoun2gGGLJC3D59Z2XEJNJ6KmhZ`, and the mainnet program once launched).
- Deploy and setup scripts in `scripts/`.

The website front end is out of scope for this repository.

## What we care about most

- Any way to take USDC from a market vault other than the payout, refund, cash out and fee paths.
- Any way to be paid more than the program's payout rules allow, or to be paid twice.
- Any way for a non-admin or the resolver key to perform admin actions.
- Any way to lock funds so that neither claims nor the emergency void can release them.

## Status

The program has an internal review (see [SECURITY_REVIEW.md](SECURITY_REVIEW.md)) and an extensive test suite, but it has **not** had an independent audit yet. Use it accordingly.
