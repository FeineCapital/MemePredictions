// Mainnet setup, called by scripts/mainnet.sh. Never prints secrets.
//   init <PHANTOM_ADDRESS> <MAX_BET_USDC>   fee vault = your Phantom's USDC account, then initialize, set the
//                                            mainnet resolver key (created if missing) and pause
//   unpause                                  open trading
//   has-config                               prints yes or no
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import idl from "../target/idl/mememarkets.json";
import { Mememarkets } from "../target/types/mememarkets";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // Circle mainnet USDC
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const FEE_BPS = 100;
const MIN_BET = 5_000_000; // 5 USDC
const DISPUTE_SECS = 300; // 5 minutes

const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const keyDir = path.join(os.homedir(), ".config/solana/mememarkets-mainnet");
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(keyDir, "deployer.json"), "utf8"))));
// The price watcher gets its own limited key on mainnet, never the devnet one and never the admin key.
const resolverPath = path.join(keyDir, "resolver.json");
if (!fs.existsSync(resolverPath)) {
  const k = Keypair.generate();
  fs.writeFileSync(resolverPath, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
}
const resolver = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolverPath, "utf8"))));
const conn = new Connection(rpc, "confirmed");
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new Program<Mememarkets>(idl as Mememarkets, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_UPGRADEABLE);
const [resolverConfig] = PublicKey.findProgramAddressSync([Buffer.from("resolver")], program.programId);

async function main() {
  const [step, a, b] = process.argv.slice(2);
  if (step === "has-config") {
    console.log((await conn.getAccountInfo(config)) ? "yes" : "no");
    return;
  }
  if (step === "init") {
    const phantom = new PublicKey(a);
    const maxUsdc = Number(b);
    if (!Number.isInteger(maxUsdc) || maxUsdc < 5 || maxUsdc > 500) throw new Error("max bet must be a whole number of USDC from 5 to 500");
    if (await conn.getAccountInfo(config)) throw new Error("already initialized");
    const feeVault = (await getOrCreateAssociatedTokenAccount(conn, deployer, USDC, phantom)).address;
    console.log(`fee vault (your Phantom USDC account): ${feeVault.toBase58()}`);
    const sig = await program.methods
      .initialize(FEE_BPS, new BN(MIN_BET), new BN(maxUsdc * 1_000_000), new BN(DISPUTE_SECS))
      .accountsPartial({ admin: deployer.publicKey, config, usdcMint: USDC, feeVault, program: program.programId, programData })
      .rpc();
    console.log(`initialize: ${sig}`);
    const r = await program.methods
      .setResolver(resolver.publicKey)
      .accountsPartial({ admin: deployer.publicKey, config, resolverConfig, systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();
    console.log(`set_resolver: ${r}`);
    const p = await program.methods.setPaused(true).accountsPartial({ admin: deployer.publicKey, config }).rpc();
    console.log(`set_paused(true): ${p}`);
    const c = await program.account.config.fetch(config);
    const rc = await program.account.resolverConfig.fetch(resolverConfig);
    const checks: [string, unknown, unknown][] = [
      ["admin", c.admin.toBase58(), deployer.publicKey.toBase58()],
      ["fee_vault", c.feeVault.toBase58(), feeVault.toBase58()],
      ["usdc_mint", c.usdcMint.toBase58(), USDC.toBase58()],
      ["fee_bps", c.feeBps, FEE_BPS],
      ["min_bet", c.minBet.toNumber(), MIN_BET],
      ["max_bet", c.maxBet.toNumber(), maxUsdc * 1_000_000],
      ["dispute_secs", c.disputeSecs.toNumber(), DISPUTE_SECS],
      ["paused", c.paused, true],
      ["curve_base", c.curveBase.toNumber(), 100_000],
      ["curve_depth", c.curveDepth.toNumber(), 10_000],
      ["resolver", rc.resolver.toBase58(), resolver.publicKey.toBase58()],
    ];
    let ok = true;
    for (const [k, got, want] of checks) {
      const pass = got === want;
      ok &&= pass;
      console.log(`${pass ? "OK  " : "FAIL"} ${k} = ${got}`);
    }
    console.log(`config account: ${config.toBase58()}`);
    fs.writeFileSync(
      path.join(__dirname, "..", "mainnet-state.json"),
      JSON.stringify({ programId: program.programId.toBase58(), config: config.toBase58(), feeVault: feeVault.toBase58(), usdcMint: USDC.toBase58(), admin: deployer.publicKey.toBase58(), upgradeAuthority: deployer.publicKey.toBase58(), resolver: resolver.publicKey.toBase58(), initialize: sig, setResolver: r, pause: p }, null, 2) + "\n"
    );
    if (!ok) process.exit(1);
    console.log(`Trading is PAUSED. Mainnet resolver (watcher) key: ${resolver.publicKey.toBase58()}`);
    console.log("Give Lovable that key with: node scripts/copy-key-for-phantom.js mainnet-resolver");
    console.log("Point Lovable at mainnet, check it, then run: ./scripts/mainnet.sh unpause");
    return;
  }
  if (step === "unpause") {
    const sig = await program.methods.setPaused(false).accountsPartial({ admin: deployer.publicKey, config }).rpc();
    console.log(`set_paused(false): ${sig}`);
    return;
  }
  throw new Error("unknown step");
}

main().catch((e) => {
  console.error(e?.error?.errorCode?.code ?? e?.message ?? e);
  process.exit(1);
});
