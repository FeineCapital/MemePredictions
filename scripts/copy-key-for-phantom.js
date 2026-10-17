// Copies a wallet's private key to the clipboard in base58 (Phantom "Import Private Key" and most server secret fields).
// Prints only the public address. Usage:
//   node ~/Desktop/mememarkets/scripts/copy-key-for-phantom.js mainnet
// Paste it into Phantom, then copy something else so the key does not stay on the clipboard.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const bs58 = require(path.join(__dirname, "..", "node_modules", "bs58"));

// mainnet | devnet | devnet-resolver | mainnet-resolver (resolver = the price watcher key, for Lovable's secret form)
const arg = process.argv[2] ?? "mainnet";
const [which, name] =
  arg === "devnet" ? ["mememarkets-devnet", "deployer"]
  : arg === "devnet-resolver" ? ["mememarkets-devnet", "resolver"]
  : arg === "mainnet-resolver" ? ["mememarkets-mainnet", "resolver"]
  : ["mememarkets-mainnet", "deployer"];
const file = path.join(os.homedir(), ".config/solana", which, `${name}.json`);
const secret = Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")));
const pub = bs58.encode(secret.slice(32));
execFileSync("pbcopy", { input: bs58.encode(secret) });
console.log(`Copied the private key for ${pub} to your clipboard. Paste it where it belongs now.`);
