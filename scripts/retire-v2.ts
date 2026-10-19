// Retires the v2 devnet program: voids or rejects unfinished markets with the admin key, pays every
// unpaid holder into their own wallet with claim_for, sweeps fees. Read-only with "list".
// Usage: npx ts-node -P tsconfig.json scripts/retire-v2.ts <list|settle>
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import idlV2 from "../archive/v2-shares/mememarkets.idl.json";

const home = (...p: string[]) => path.join(os.homedir(), ".config/solana", ...p);
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(home("mememarkets-mainnet", "deployer.json"), "utf8"))));
const rpc = `https://devnet.helius-rpc.com/?api-key=${fs.readFileSync(home("mememarkets-mainnet", "helius-key"), "utf8").trim()}`;
const conn = new Connection(rpc, "confirmed");
const program = new Program(idlV2 as any, new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" })) as any;
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const pid: PublicKey = program.programId;
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], pid)[0];
const positionPda = (m: PublicKey, u: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], pid)[0];
const fmt = (n: bigint | number) => (Number(n) / 1e6).toFixed(6);

async function snapshot() {
  const markets = await program.account.market.all();
  const rows: any[] = [];
  for (const { publicKey, account: m } of markets) {
    const vault = (await getAccount(conn, vaultPda(publicKey))).amount;
    const positions = await program.account.position.all([{ memcmp: { offset: 8, bytes: publicKey.toBase58() } }]);
    rows.push({ market: publicKey, m, vault, positions });
  }
  return rows.sort((a, b) => a.m.id.toNumber() - b.m.id.toNumber());
}

(async () => {
  const step = process.argv[2];
  const cfg = await program.account.config.fetch(configPda);
  console.log(`v2 program ${pid.toBase58()} admin ${cfg.admin.toBase58()} fee vault ${cfg.feeVault.toBase58()}`);
  let rows = await snapshot();
  let total = 0n;
  for (const r of rows) {
    total += r.vault;
    const unpaid = r.positions.filter((p: any) => !p.account.claimed && p.account.shares.toNumber() > 0);
    console.log(`#${r.m.id} ${Object.keys(r.m.status)[0]} vault ${fmt(r.vault)} USDC, holders ${r.positions.length}, unpaid ${unpaid.length} [${unpaid.map((p: any) => p.account.user.toBase58().slice(0, 6)).join(", ")}] feeCollected ${r.m.feeCollected}`);
  }
  console.log(`total USDC in v2 vaults: ${fmt(total)}`);
  if (step !== "settle") return;

  const adminAcc = { admin: admin.publicKey, config: configPda };
  for (const r of rows) {
    const s = Object.keys(r.m.status)[0];
    if (s === "open" || s === "locked") console.log(`void #${r.m.id}: ${await program.methods.voidMarket().accountsPartial({ ...adminAcc, market: r.market }).rpc()}`);
    if (s === "pending") console.log(`reject #${r.m.id}: ${await program.methods.rejectMarket().accountsPartial({ ...adminAcc, market: r.market }).rpc()}`);
  }
  rows = await snapshot();
  const now = Math.floor(Date.now() / 1000);
  for (const r of rows) {
    const s = Object.keys(r.m.status)[0];
    if (s === "resolved" && (r.m.disputed || now < r.m.disputeEnds.toNumber())) { console.log(`#${r.m.id} still in its dispute window, skipped`); continue; }
    for (const p of r.positions) {
      if (p.account.claimed || p.account.shares.toNumber() === 0) continue;
      const owner: PublicKey = p.account.user;
      const dest = getAssociatedTokenAddressSync(USDC, owner);
      try {
        const sig = await program.methods.claimFor().accountsPartial({ caller: admin.publicKey, owner, config: configPda, market: r.market,
          vault: vaultPda(r.market), position: positionPda(r.market, owner), ownerUsdc: dest, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
        console.log(`paid #${r.m.id} ${owner.toBase58().slice(0, 6)}: ${sig}`);
      } catch (e: any) { console.log(`#${r.m.id} ${owner.toBase58().slice(0, 6)} not paid: ${e?.error?.errorCode?.code ?? e?.message}`); }
    }
    if (!r.m.feeCollected) {
      try {
        console.log(`fees #${r.m.id}: ${await program.methods.collectFees().accountsPartial({ caller: admin.publicKey, config: configPda, market: r.market,
          vault: vaultPda(r.market), feeVault: cfg.feeVault, tokenProgram: TOKEN_PROGRAM_ID }).rpc()}`);
      } catch (e: any) { console.log(`#${r.m.id} fees: ${e?.error?.errorCode?.code ?? e?.message}`); }
    }
  }
  rows = await snapshot();
  let left = 0n;
  for (const r of rows) left += r.vault;
  console.log(`left in v2 vaults after settling: ${fmt(left)} USDC`);
})().then(() => process.exit(0)).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
