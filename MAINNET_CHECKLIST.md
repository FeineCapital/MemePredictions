# Mainnet launch checklist

Status: public beta on devnet. Mainnet launches after the beta.

## Before launch
- [ ] Beta feedback fixed and re-tested (`./scripts/build.sh test && anchor test --skip-build`)
- [ ] Production build matches `EXPECTED_MD5` in `scripts/mainnet.sh` (`./scripts/build.sh`)
- [ ] Independent audit (recommended before real money at scale)
- [ ] Legal check on where the platform can operate

## Launch
1. Make sure the launch wallet `7TPuntBHLRAyjBNKvMx24aKcXL9aGT2uaacUPJSWEMeF` holds at least 3 SOL (about 2.73 SOL becomes the program's refundable storage deposit).
2. Deploy, verifying the binary before and after and publishing the IDL:
   `RPC_URL="https://mainnet.helius-rpc.com/?api-key=$(cat ~/.config/solana/mememarkets-mainnet/helius-key)" scripts/mainnet.sh deploy`
3. Initialize (Circle USDC, 1% fee, 5 USDC min, max bet, 5 minute payout window, new mainnet resolver key, starts paused):
   `RPC_URL=... scripts/mainnet.sh init <FEE_WALLET> <MAX_BET_USDC>`
4. Fund the mainnet resolver with about 0.1 SOL for transaction fees.
5. Switch the site to mainnet: program ID, config, fee vault, USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, paid RPC, and the mainnet resolver key in the server secrets.
6. Test one small market end to end with a non-admin wallet.
7. Open trading: `RPC_URL=... scripts/mainnet.sh unpause`
8. Send Phantom the mainnet program ID and a transaction link (domain review).
9. Verified build: deploy from a reproducible `solana-verify build`, then submit it so Solscan shows the program as verified against this repository.

## After launch
- [ ] Watch every market for the first weeks
- [ ] Move the admin and upgrade authority to a Squads multisig
- [ ] Raise limits gradually
