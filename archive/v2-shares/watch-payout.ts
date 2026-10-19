// Read-only: waits for someone else (the site's watcher) to pay a market's holders, and reports who paid.
// Usage: npx ts-node -P tsconfig.json scripts/watch-payout.ts <market address> [max minutes]
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../target/idl/mememarkets.json";
import { Mememarkets } from "../target/types/mememarkets";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const program = new Program<Mememarkets>(idl as Mememarkets, new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), {}));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const market = new PublicKey(process.argv[2]);
  const deadline = Date.now() + Number(process.argv[3] ?? 40) * 60_000;
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    try {
      const sigs = await conn.getSignaturesForAddress(market, { limit: 20 });
      for (const s of sigs.reverse()) {
        if (seen.has(s.signature) || s.err) continue;
        seen.add(s.signature);
        const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        const ix = (tx?.meta?.logMessages ?? []).find((l) => l.startsWith("Program log: Instruction: "))?.slice(26);
        if (ix === "ClaimFor" || ix === "Claim" || ix === "CollectFees") {
          const by = tx!.transaction.message.staticAccountKeys[0].toBase58();
          console.log(`${new Date((s.blockTime ?? 0) * 1000).toISOString().slice(11, 19)} ${ix} sent by ${by} https://solscan.io/tx/${s.signature}?cluster=devnet`);
        }
      }
      const positions = await program.account.position.all([{ memcmp: { offset: 8, bytes: market.toBase58() } }]);
      const m = await program.account.market.fetch(market);
      const winnersUnpaid = positions.filter((p) => p.account.side === m.result && !p.account.claimed && p.account.shares.toNumber() > 0);
      if (winnersUnpaid.length === 0 && m.feeCollected) {
        console.log("DONE: every winner paid and fee collected");
        for (const p of positions) console.log(`  ${p.account.user.toBase58().slice(0, 6)} side ${p.account.side} claimed ${p.account.claimed}`);
        return;
      }
    } catch (e: any) {
      if (!String(e?.message).includes("429")) console.log("read error, retrying:", e?.message);
    }
    await sleep(20_000);
  }
  console.log("TIMEOUT: no automatic payout seen");
})();
