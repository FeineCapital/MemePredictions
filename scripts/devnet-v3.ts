// Devnet setup and live test for v3: 3 outcome market, bonus, open creation with creator fees, auto payouts.
// Usage: npx ts-node -P tsconfig.json scripts/devnet-v3.ts <setup|run|pay|status>
// Uses the Helius devnet RPC from ~/.config/solana/mememarkets-mainnet/helius-key. Never prints secrets.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, transfer } from "@solana/spl-token";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import idl from "../target/idl/mememarkets.json";
import { Mememarkets } from "../target/types/mememarkets";

const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const U = 1_000_000;
const STATE = path.join(__dirname, "..", "devnet-v3.json");
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const home = (...p: string[]) => path.join(os.homedir(), ".config/solana", ...p);
const load = (dir: string, n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(home(dir, `${n}.json`), "utf8"))));
const deployer = load("mememarkets-devnet", "deployer"); // upgrade authority, also plays the treasury and the payout bot here
const admin = load("mememarkets-mainnet", "deployer"); // 7TPunt
const resolver = load("mememarkets-devnet", "resolver");
const bettor1 = load("mememarkets-devnet", "bettor1");
const bettor2 = load("mememarkets-devnet", "bettor2");
const rpc = `https://devnet.helius-rpc.com/?api-key=${fs.readFileSync(home("mememarkets-mainnet", "helius-key"), "utf8").trim()}`;
const conn = new Connection(rpc, "confirmed");
const as = (k: Keypair) => new Program<Mememarkets>(idl as Mememarkets, new anchor.AnchorProvider(conn, new anchor.Wallet(k), { commitment: "confirmed" }));
const program = as(admin);
const pid = program.programId;
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
const [resolverPda] = PublicKey.findProgramAddressSync([Buffer.from("resolver")], pid);
const [programData] = PublicKey.findProgramAddressSync([pid.toBuffer()], BPF_UPGRADEABLE);
const marketPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], pid)[0];
const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], pid)[0];
const positionPda = (m: PublicKey, u: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], pid)[0];
const bonusPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("bonus"), m.toBuffer()], pid)[0];
const usdcOf = (k: PublicKey) => getAssociatedTokenAddressSync(USDC, k);
const hash = (t: string) => Array.from(createHash("sha256").update(t).digest());

const state: Record<string, any> = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { ok: {}, mustFail: {}, notes: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
const record = (name: string, sig: string) => { state.ok[name] = sig; save(); console.log(`${name}: ${sig}`); };
const note = (k: string, v: unknown) => { state.notes[k] = String(v); save(); console.log(`  ${k}: ${v}`); };
const chainNow = async () => Number((await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32));
const usdcBal = async (k: PublicKey) => (await getAccount(conn, usdcOf(k))).amount;
const fmt = (n: bigint | number) => (Number(n) / 1e6).toFixed(6);

async function mustFail(name: string, builder: any, signers: Keypair[], code: string) {
  const tx: Transaction = await builder.transaction();
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");
  const r = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const pass = !!r?.meta?.err && (r?.meta?.logMessages ?? []).join("\n").includes(code);
  state.mustFail[name] = { sig, expected: code, pass };
  save();
  console.log(`${pass ? "OK  " : "FAIL"} ${name} -> ${code}: ${sig}`);
  if (!pass) process.exitCode = 1;
}

const trade = (k: Keypair, market: PublicKey) => ({
  user: k.publicKey, config: configPda, market, vault: vaultPda(market), position: positionPda(market, k.publicKey),
  userUsdc: usdcOf(k.publicKey), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
});
const ra = (market: PublicKey) => ({ authority: resolver.publicKey, config: configPda, resolverConfig: resolverPda, market });
async function create(k: Keypair, outcomes: number, side: number, amount: number, rules: string) {
  const c = await program.account.config.fetch(configPda);
  const market = marketPda(c.marketCount);
  const endTs = (await chainNow()) + 3600 + 120;
  const sig = await as(k).methods
    .createMarket(Keypair.generate().publicKey, 0, 0, new BN(outcomes === 2 ? 1_000_000 : 0), 0, new BN(endTs), outcomes, side, new BN(amount), new BN(0), hash(rules))
    .accountsPartial({ creator: k.publicKey, config: configPda, usdcMint: USDC, market, vault: vaultPda(market),
      position: positionPda(market, k.publicKey), creatorUsdc: usdcOf(k.publicKey), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .rpc();
  return { market, sig };
}

async function main() {
  const step = process.argv[2];
  if (step === "setup") {
    const p = as(deployer);
    record("initialize", await p.methods.initialize(100, new BN(5 * U), new BN(500 * U), new BN(300))
      .accountsPartial({ admin: deployer.publicKey, config: configPda, usdcMint: USDC, feeVault: usdcOf(admin.publicKey), program: pid, programData, systemProgram: SystemProgram.programId }).rpc());
    record("set_resolver", await p.methods.setResolver(resolver.publicKey)
      .accountsPartial({ admin: deployer.publicKey, config: configPda, resolverConfig: resolverPda, systemProgram: SystemProgram.programId }).rpc());
    record("set_admin", await p.methods.setAdmin(admin.publicKey).accountsPartial({ admin: deployer.publicKey, config: configPda }).rpc());
    const c = await program.account.config.fetch(configPda);
    console.log(JSON.stringify({ program: pid.toBase58(), config: configPda.toBase58(), admin: c.admin.toBase58(), feeVault: c.feeVault.toBase58(),
      resolver: (await program.account.resolverConfig.fetch(resolverPda)).resolver.toBase58(), fee: c.feeBps, min: c.minBet.toNumber(), max: c.maxBet.toNumber(),
      payoutDelay: c.disputeSecs.toNumber(), openCreation: c.openCreation, creatorShare: c.creatorFeeShareBps, paused: c.paused }, null, 1));
  } else if (step === "run") {
    // Funding: SOL for the bettors, test USDC from the admin wallet.
    const tx = new Transaction();
    for (const b of [bettor1, bettor2]) tx.add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: b.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
    record("fund_sol", await anchor.web3.sendAndConfirmTransaction(conn, tx, [deployer]));
    for (const [i, b] of [[1, bettor1], [2, bettor2]] as const) {
      const need = 10n * BigInt(U) - (await usdcBal(b.publicKey));
      if (need > 0n) record(`fund_usdc_bettor${i}`, await transfer(conn, admin, usdcOf(admin.publicKey), usdcOf(b.publicKey), admin, need));
    }

    // A) Official 3 outcome market by the admin: opens instantly and Verified. Bonus from the treasury.
    const a = await create(admin, 3, 1, 5 * U, "Which hits $10M first: A, B or C? (devnet test)");
    record("a_admin_create_3_outcomes", a.sig);
    const ma = await program.account.market.fetch(a.market);
    note("a_status_verified_share", `${Object.keys(ma.status)[0]} verified=${ma.verified} creatorShare=${ma.creatorFeeBps}`);
    record("a_bettor1_buy_outcome2", await as(bettor1).methods.buyShares(2, new BN(5 * U), new BN(0)).accountsPartial(trade(bettor1, a.market)).rpc());
    record("a_bettor2_buy_outcome3", await as(bettor2).methods.buyShares(3, new BN(5 * U), new BN(0)).accountsPartial(trade(bettor2, a.market)).rpc());
    await mustFail("a_buy_outcome4", program.methods.buyShares(4, new BN(5 * U), new BN(0)).accountsPartial(trade(bettor1, a.market)), [bettor1], "BadSide");
    // The devnet deployer plays the treasury: give it 3 test USDC, then it funds a bonus without taking a side.
    const treasuryUsdc = (await getOrCreateAssociatedTokenAccount(conn, deployer, USDC, deployer.publicKey)).address;
    if ((await getAccount(conn, treasuryUsdc)).amount < 3n * BigInt(U)) {
      record("fund_treasury_usdc", await transfer(conn, admin, usdcOf(admin.publicKey), treasuryUsdc, admin, 3 * U));
    }
    record("a_treasury_bonus_3", await as(deployer).methods.addBonus(new BN(3 * U))
      .accountsPartial({ funder: deployer.publicKey, config: configPda, market: a.market, vault: vaultPda(a.market), bonus: bonusPda(a.market),
        funderUsdc: treasuryUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc());
    record("a_resolver_lock", await as(resolver).methods.lockMarket().accountsPartial(ra(a.market)).rpc());
    record("a_resolver_resolve_outcome3_early", await as(resolver).methods.resolveMarket(3, new BN(10_000_000)).accountsPartial(ra(a.market)).rpc());
    state.marketA = a.market.toBase58();

    // B) Open creation: a user's 2 outcome market goes live without approval and earns 50% of the fee.
    record("b_set_creation_open_50pct", await program.methods.setCreation(true, 5_000).accountsPartial({ admin: admin.publicKey, config: configPda }).rpc());
    const b = await create(bettor1, 2, 1, 5 * U, "Will $TEST hit $1M by tomorrow? (devnet test)");
    record("b_user_create_2_outcomes", b.sig);
    const mb = await program.account.market.fetch(b.market);
    note("b_status_verified_share", `${Object.keys(mb.status)[0]} verified=${mb.verified} creatorShare=${mb.creatorFeeBps}`);
    record("b_bettor2_buy_no", await as(bettor2).methods.buyShares(2, new BN(5 * U), new BN(0)).accountsPartial(trade(bettor2, b.market)).rpc());
    record("b_set_creation_closed", await program.methods.setCreation(false, 0).accountsPartial({ admin: admin.publicKey, config: configPda }).rpc());
    record("b_resolver_lock", await as(resolver).methods.lockMarket().accountsPartial(ra(b.market)).rpc());
    record("b_resolver_resolve_yes_early", await as(resolver).methods.resolveMarket(1, new BN(1_000_000)).accountsPartial(ra(b.market)).rpc());
    state.marketB = b.market.toBase58();
    state.payAfter = Math.max((await program.account.market.fetch(a.market)).disputeEnds.toNumber(), (await program.account.market.fetch(b.market)).disputeEnds.toNumber());
    save();
    console.log(`payouts open at ${new Date(state.payAfter * 1000).toISOString()}`);
  } else if (step === "pay") {
    const crank = as(deployer);
    for (const [label, key, holders, creator] of [
      ["a", state.marketA, [admin, bettor1, bettor2], admin],
      ["b", state.marketB, [bettor1, bettor2], bettor1],
    ] as const) {
      const market = new PublicKey(key);
      for (const h of holders) {
        const before = await usdcBal(h.publicKey);
        record(`${label}_auto_pay_${h.publicKey.toBase58().slice(0, 4)}`, await crank.methods.claimFor()
          .accountsPartial({ caller: deployer.publicKey, owner: h.publicKey, config: configPda, market, vault: vaultPda(market),
            position: positionPda(market, h.publicKey), ownerUsdc: usdcOf(h.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).rpc());
        note(`${label}_paid_${h.publicKey.toBase58().slice(0, 4)}`, fmt((await usdcBal(h.publicKey)) - before));
      }
      const fv = (await program.account.config.fetch(configPda)).feeVault;
      const fb = (await getAccount(conn, fv)).amount;
      record(`${label}_collect_fees`, await crank.methods.collectFees()
        .accountsPartial({ caller: deployer.publicKey, config: configPda, market, vault: vaultPda(market), feeVault: fv, tokenProgram: TOKEN_PROGRAM_ID }).rpc());
      note(`${label}_platform_fee`, fmt((await getAccount(conn, fv)).amount - fb));
      const m = await program.account.market.fetch(market);
      note(`${label}_creator_fee_owed`, fmt(m.creatorFeeOwed.toNumber()));
      if (label === "b") {
        await mustFail("b_creator_fee_to_wrong_wallet", crank.methods.claimCreatorFee().accountsPartial({ caller: deployer.publicKey, creator: creator.publicKey,
          config: configPda, market, vault: vaultPda(market), creatorUsdc: usdcOf(bettor2.publicKey), tokenProgram: TOKEN_PROGRAM_ID }), [deployer], "ConstraintTokenOwner");
        const cb = await usdcBal(creator.publicKey);
        record("b_creator_fee_paid", await crank.methods.claimCreatorFee().accountsPartial({ caller: deployer.publicKey, creator: creator.publicKey,
          config: configPda, market, vault: vaultPda(market), creatorUsdc: usdcOf(creator.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).rpc());
        note("b_creator_received", fmt((await usdcBal(creator.publicKey)) - cb));
      }
      note(`${label}_vault_left`, fmt((await getAccount(conn, vaultPda(market))).amount));
    }
  } else if (step === "status") {
    const now = await chainNow();
    console.log(JSON.stringify({ now, payAfter: state.payAfter, ready: now >= (state.payAfter ?? Infinity) }));
  }
}

main().catch((e) => { console.error(e?.error?.errorCode?.code ?? e?.message ?? e); process.exit(1); });
