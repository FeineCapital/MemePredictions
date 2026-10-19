// Usage: npx ts-node -P tsconfig.json scripts/set-dispute.ts <seconds>
// Sets the dispute window (payout delay) for NEW markets on devnet. Existing markets keep theirs. Fee and limits stay as they are.
// Signs with the devnet admin, which is the 7TPunt wallet (its key file lives in mememarkets-mainnet/deployer.json).
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import idl from "../target/idl/mememarkets.json";
import { Mememarkets } from "../target/types/mememarkets";

const secs = Number(process.argv[2]);
if (!Number.isInteger(secs) || secs < 0) throw new Error("pass seconds");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/mememarkets-mainnet/deployer.json"), "utf8"))));
const provider = new anchor.AnchorProvider(new Connection("https://api.devnet.solana.com", "confirmed"), new anchor.Wallet(kp), { commitment: "confirmed" });
const program = new Program<Mememarkets>(idl as Mememarkets, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
(async () => {
  const c = await program.account.config.fetch(config);
  const sig = await program.methods.setLimits(c.feeBps, c.minBet, c.maxBet, new BN(secs)).accountsPartial({ admin: kp.publicKey, config }).rpc();
  const after = await program.account.config.fetch(config);
  console.log(`set_limits: ${sig}`);
  console.log(`dispute_secs ${c.disputeSecs.toString()} -> ${after.disputeSecs.toString()}, fee_bps ${after.feeBps}, min ${after.minBet.toString()}, max ${after.maxBet.toString()}`);
})();
