#!/usr/bin/env bash
# MemeMarkets mainnet helper. Run it yourself, one step at a time.
#   ./scripts/mainnet.sh balance                       show the deployer wallet and its SOL
#   ./scripts/mainnet.sh deploy                        deploy the tested production build (asks you to type DEPLOY)
#   ./scripts/mainnet.sh init <PHANTOM_ADDRESS> <MAX>  set up config, fees to your Phantom USDC, watcher key, starts PAUSED
#   ./scripts/mainnet.sh unpause                       open trading (only when the app is ready)
#   ./scripts/mainnet.sh refund <PHANTOM_ADDRESS>      before init only: close the program and send all SOL back
# The deployer key lives in ~/.config/solana/mememarkets-mainnet and never leaves this laptop.
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="$HOME/.config/solana/mememarkets-mainnet/deployer.json"
RPC="${RPC_URL:-https://api.mainnet-beta.solana.com}"
PROGRAM_KEYPAIR="target/deploy/mememarkets-keypair.json"
PROGRAM_ID="3B84AX7kyaGSMrxyKZrJBng4MQtirx9CF1G54yGGL1RM"
SO="target/deploy/mememarkets.so"
# md5 of the production build that passed all tests and runs on devnet. Not the short-time test build.
EXPECTED_MD5="e9dc38193ac9a249d613e74f2c4dc862"

DEPLOYER="$(solana-keygen pubkey "$KEY")"
step="${1:-}"

check_build() {
  local got
  got="$(md5 -q "$SO")"
  if [ "$got" != "$EXPECTED_MD5" ]; then
    echo "STOP: $SO is not the tested production build (md5 $got). Run ./scripts/build.sh and check again."
    exit 1
  fi
  [ "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")" = "$PROGRAM_ID" ] || { echo "STOP: program keypair does not match $PROGRAM_ID"; exit 1; }
  echo "Build OK: production build, program id $PROGRAM_ID"
}

case "$step" in
  balance)
    echo "Deployer wallet: $DEPLOYER"
    solana balance "$DEPLOYER" -u "$RPC"
    ;;
  deploy)
    check_build
    bal="$(solana balance "$DEPLOYER" -u "$RPC" | awk '{print $1}')"
    echo "Deployer $DEPLOYER has $bal SOL"
    awk -v b="$bal" 'BEGIN { exit !(b >= 2.8) }' || { echo "STOP: need at least 2.8 SOL, send 3.5 to be safe."; exit 1; }
    if solana program show "$PROGRAM_ID" -u "$RPC" >/dev/null 2>&1; then
      echo "STOP: the program already exists on mainnet. Nothing to do."; exit 1
    fi
    echo
    echo "This deploys to MAINNET with real SOL. About 2.5 SOL becomes a refundable storage deposit."
    read -r -p "Type DEPLOY to continue: " ok
    [ "$ok" = "DEPLOY" ] || { echo "Cancelled."; exit 1; }
    solana program deploy "$SO" \
      --program-id "$PROGRAM_KEYPAIR" \
      --upgrade-authority "$KEY" -k "$KEY" -u "$RPC" \
      --with-compute-unit-price 20000 --max-sign-attempts 100 --use-rpc
    tmp="$(mktemp -d)"
    solana program dump "$PROGRAM_ID" "$tmp/onchain.so" -u "$RPC" >/dev/null
    got="$(head -c "$(stat -f%z "$SO")" "$tmp/onchain.so" | md5 -q)"
    rm -rf "$tmp"
    [ "$got" = "$EXPECTED_MD5" ] && echo "VERIFIED: on chain bytes match the tested build." || { echo "WARNING: on chain bytes do not match ($got)"; exit 1; }
    # Publish the IDL on chain so wallets, scanners and Solscan can decode every instruction.
    anchor idl init -f target/idl/mememarkets.json "$PROGRAM_ID" --provider.cluster "$RPC" --provider.wallet "$KEY" || echo "NOTE: IDL publish failed, rerun: anchor idl init -f target/idl/mememarkets.json $PROGRAM_ID --provider.cluster $RPC --provider.wallet $KEY"
    echo "Next: ./scripts/mainnet.sh init <YOUR_PHANTOM_ADDRESS> 50"
    ;;
  init)
    [ $# -eq 3 ] || { echo "usage: ./scripts/mainnet.sh init <PHANTOM_ADDRESS> <MAX_BET_USDC>"; exit 1; }
    RPC_URL="$RPC" npx ts-node -P tsconfig.json scripts/mainnet-init.ts init "$2" "$3"
    ;;
  unpause)
    read -r -p "Open real money trading on MAINNET? Type OPEN: " ok
    [ "$ok" = "OPEN" ] || { echo "Cancelled."; exit 1; }
    RPC_URL="$RPC" npx ts-node -P tsconfig.json scripts/mainnet-init.ts unpause
    ;;
  refund)
    [ $# -eq 2 ] || { echo "usage: ./scripts/mainnet.sh refund <PHANTOM_ADDRESS>"; exit 1; }
    if RPC_URL="$RPC" npx ts-node -P tsconfig.json scripts/mainnet-init.ts has-config | grep -q yes; then
      echo "STOP: config exists, markets may hold user funds. Closing the program would lock them. Not closing."
      exit 1
    fi
    if solana program show "$PROGRAM_ID" -u "$RPC" >/dev/null 2>&1; then
      read -r -p "Close the mainnet program and refund its deposit? Type CLOSE: " ok
      [ "$ok" = "CLOSE" ] || { echo "Cancelled."; exit 1; }
      solana program close "$PROGRAM_ID" --recipient "$DEPLOYER" --authority "$KEY" -k "$KEY" -u "$RPC" --bypass-warning
    fi
    solana transfer "$2" ALL --allow-unfunded-recipient -k "$KEY" -u "$RPC"
    echo "All SOL sent back to $2"
    ;;
  *)
    sed -n '2,8p' "$0"
    ;;
esac
