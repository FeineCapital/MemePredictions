#!/usr/bin/env bash
# Builds the SBF binary with platform tools v1.52 (the default v1.51 Cargo cannot parse edition 2024 crates),
# then the IDL. Pass "test" to build the short-time test build (never deploy that one).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = "test" ]; then
  anchor build --no-idl -- --tools-version v1.52 --features short-time
else
  anchor build --no-idl -- --tools-version v1.52
fi
anchor idl build -o target/idl/mememarkets.json -t target/types/mememarkets.ts
