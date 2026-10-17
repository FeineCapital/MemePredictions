// Decodes every trade on a market from chain logs and recomputes each one with independent bigint math.
// Usage: npx ts-node -P tsconfig.json scripts/verify-market.ts <market id>
import * as anchor from "@coral-xyz/anchor";
import { BN, EventParser, BorshCoder, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../target/idl/mememarkets.json";
import { Mememarkets } from "../target/types/mememarkets";

const SHARE = 1_000_000n;
const num = (a: bigint, b: bigint, base: bigint, depth: bigint) => 2n * depth * base * (b - a) + b * b - a * a;
const den = (depth: bigint) => 2n * depth * SHARE;
const buyCost = (s: bigint, n: bigint, base: bigint, depth: bigint) => (num(s, s + n, base, depth) + den(depth) - 1n) / den(depth);
const sellValue = (s: bigint, n: bigint, base: bigint, depth: bigint) => num(s - n, s, base, depth) / den(depth);
function isqrt(n: bigint) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }
function quoteBuy(s: bigint, usdc: bigint, base: bigint, depth: bigint): [bigint, bigint] {
  const k = depth * base; let n = isqrt((s + k) * (s + k) + den(depth) * usdc) - k - s; let c = buyCost(s, n, base, depth);
  while (n > 0n && c > usdc) { n -= 1n; c = buyCost(s, n, base, depth); } return [n, c];
}
const fmt = (n: bigint) => (Number(n) / 1e6).toFixed(6);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const program = new Program<Mememarkets>(idl as Mememarkets, new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), {}));
const parser = new EventParser(program.programId, new BorshCoder(idl as any));

(async () => {
  const id = new BN(process.argv[2]);
  const market = PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], program.programId)[0];
  const m = await program.account.market.fetch(market);
  const base = BigInt(m.curveBase.toString()), depth = BigInt(m.curveDepth.toString()), feeBps = BigInt(m.feeBps);
  console.log(`market #${id} ${market.toBase58()} status ${Object.keys(m.status)[0]} curve base ${fmt(base)} depth ${depth}`);
  const sigs = (await conn.getSignaturesForAddress(market, { limit: 100 })).reverse();
  let ys = 0n, ns = 0n, ok = true;
  for (const s of sigs) {
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) continue;
    const ixName = (tx.meta?.logMessages ?? []).find((l) => l.startsWith("Program log: Instruction: "))?.slice(26);
    for (const ev of parser.parseLogs(tx.meta?.logMessages ?? [])) {
      if (ev.name !== "Traded") continue;
      const d: any = ev.data;
      const side = d.side === 1 ? "Yes" : "No";
      const supply = d.side === 1 ? ys : ns;
      const shares = BigInt(d.shares.toString()), usdc = BigInt(d.usdc.toString());
      let exp: string, pass: boolean;
      if (d.buy) {
        const [n, c] = quoteBuy(supply, usdc, base, depth); // usdc paid equals the cost of exactly n shares
        pass = n === shares && c === usdc;
        exp = `expected ${fmt(n)} shares for ${fmt(c)} USDC`;
        if (d.side === 1) ys += shares; else ns += shares;
      } else {
        const g = sellValue(supply, shares, base, depth); const out = g - (g * feeBps) / 10_000n;
        pass = out === usdc;
        exp = `expected ${fmt(out)} USDC (gross ${fmt(g)} minus 1% fee)`;
        if (d.side === 1) ys -= shares; else ns -= shares;
      }
      ok &&= pass;
      console.log(`${pass ? "OK  " : "FAIL"} ${ixName}: ${d.buy ? "bought" : "sold"} ${fmt(shares)} ${side} shares for ${fmt(usdc)} USDC. ${exp}. Price after: Yes ${fmt(BigInt((d.yes_price ?? d.yesPrice).toString()))} No ${fmt(BigInt((d.no_price ?? d.noPrice).toString()))}. ${s.signature}`);
    }
  }
  console.log(`replayed supply Yes ${fmt(ys)} No ${fmt(ns)} | on chain Yes ${fmt(BigInt(m.yesShares.toString()))} No ${fmt(BigInt(m.noShares.toString()))}`);
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], program.programId)[0];
  const v = BigInt((await conn.getTokenAccountBalance(vault)).value.amount);
  const reserves = BigInt(m.yesReserve.toString()) + BigInt(m.noReserve.toString());
  console.log(`vault ${fmt(v)} USDC | reserves ${fmt(reserves)} | ${v === reserves ? "OK match" : "MISMATCH"}`);
  for (const p of await program.account.position.all([{ memcmp: { offset: 8, bytes: market.toBase58() } }])) {
    const a = p.account;
    console.log(`position ${a.user.toBase58().slice(0, 6)}: ${a.side === 1 ? "Yes" : "No"} ${fmt(BigInt(a.shares.toString()))} shares, cost ${fmt(BigInt(a.cost.toString()))} USDC, claimed ${a.claimed}`);
  }
  if (!ok) process.exit(1);
})();
