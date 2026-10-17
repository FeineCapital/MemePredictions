// Devnet setup and live test for the share trading program.
// Usage: npx ts-node -P tsconfig.json scripts/devnet-v2.ts <setup|trade|resolve|claim|status>
// Never prints secrets. Writes public results to devnet-v2.json.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, transfer } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import idl from "../target/idl/mememarkets.json";
import { Mememarkets } from "../target/types/mememarkets";

const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const U = 1_000_000;
const STATE = path.join(__dirname, "..", "devnet-v2.json");
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const load = (dir: string, n: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana", dir, `${n}.json`), "utf8"))));
const deployer = load("mememarkets-devnet", "deployer"); // upgrade authority, initial admin
const admin = load("mememarkets-mainnet", "deployer"); // 7TPunt, the user's admin wallet
const resolver = load("mememarkets-devnet", "resolver");
const bettor1 = load("mememarkets-devnet", "bettor1");
const bettor2 = load("mememarkets-devnet", "bettor2");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const as = (k: Keypair) => new Program<Mememarkets>(idl as Mememarkets, new anchor.AnchorProvider(conn, new anchor.Wallet(k), { commitment: "confirmed" }));
const program = as(admin);
const pid = program.programId;
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
const [resolverPda] = PublicKey.findProgramAddressSync([Buffer.from("resolver")], pid);
const [programData] = PublicKey.findProgramAddressSync([pid.toBuffer()], BPF_UPGRADEABLE);
const marketPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], pid)[0];
const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], pid)[0];
const positionPda = (m: PublicKey, u: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], pid)[0];
const usdcOf = (k: PublicKey) => getAssociatedTokenAddressSync(USDC, k);

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
const ra = (k: Keypair, market: PublicKey) => ({ authority: k.publicKey, config: configPda, resolverConfig: resolverPda, market });
const price = async (market: PublicKey) => {
  const m = await program.account.market.fetch(market);
  const b = m.curveBase.toNumber(), d = m.curveDepth.toNumber();
  return { yes: b + Math.floor(m.yesShares.toNumber() / d), no: b + Math.floor(m.noShares.toNumber() / d) };
};

async function main() {
  const step = process.argv[2];
  if (step === "setup") {
    const p = as(deployer);
    const feeVault = usdcOf(admin.publicKey);
    record("initialize", await p.methods.initialize(100, new BN(5 * U), new BN(5000 * U), new BN(300))
      .accountsPartial({ admin: deployer.publicKey, config: configPda, usdcMint: USDC, feeVault, program: pid, programData, systemProgram: SystemProgram.programId }).rpc());
    record("set_resolver", await p.methods.setResolver(resolver.publicKey)
      .accountsPartial({ admin: deployer.publicKey, config: configPda, resolverConfig: resolverPda, systemProgram: SystemProgram.programId }).rpc());
    record("set_admin", await p.methods.setAdmin(admin.publicKey).accountsPartial({ admin: deployer.publicKey, config: configPda }).rpc());
    const tx = new Transaction();
    for (const b of [bettor1, bettor2]) tx.add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: b.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
    record("fund_bettor_sol", await anchor.web3.sendAndConfirmTransaction(conn, tx, [deployer]));
    record("fund_bettor2_usdc", await transfer(conn, deployer, usdcOf(bettor1.publicKey), usdcOf(bettor2.publicKey), bettor1, 5 * U));
    const c = await program.account.config.fetch(configPda);
    const r = await program.account.resolverConfig.fetch(resolverPda);
    console.log(JSON.stringify({ config: configPda.toBase58(), admin: c.admin.toBase58(), resolver: r.resolver.toBase58(), feeVault: c.feeVault.toBase58(),
      usdc: c.usdcMint.toBase58(), fee: c.feeBps, min: c.minBet.toNumber(), max: c.maxBet.toNumber(), payoutDelay: c.disputeSecs.toNumber(),
      curveBase: c.curveBase.toNumber(), curveDepth: c.curveDepth.toNumber(), paused: c.paused }, null, 1));
  } else if (step === "trade") {
    const c = await program.account.config.fetch(configPda);
    const market = marketPda(c.marketCount);
    const endTs = (await chainNow()) + 3600 + 120;
    state.market = market.toBase58();
    save();
    const b1Start = await usdcBal(bettor1.publicKey);
    record("create_market_bettor1_yes_5", await as(bettor1).methods
      .createMarket(new PublicKey("So11111111111111111111111111111111111111112"), 0, 0, new BN(1_000_000), 0, new BN(endTs), 1, new BN(5 * U), new BN(0))
      .accountsPartial({ creator: bettor1.publicKey, config: configPda, usdcMint: USDC, market, vault: vaultPda(market),
        position: positionPda(market, bettor1.publicKey), creatorUsdc: usdcOf(bettor1.publicKey), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc());
    const b1Paid = b1Start - (await usdcBal(bettor1.publicKey));
    note("bettor1_paid", fmt(b1Paid));
    record("approve_by_admin", await program.methods.approveMarket().accountsPartial({ admin: admin.publicKey, config: configPda, market }).rpc());
    note("yes_price_before", fmt((await price(market)).yes));
    record("bettor2_buy_yes_6", await as(bettor2).methods.buyShares(1, new BN(6 * U), new BN(0)).accountsPartial(trade(bettor2, market)).rpc());
    note("yes_price_after", fmt((await price(market)).yes));

    await mustFail("bettor2_buy_other_side", program.methods.buyShares(2, new BN(5 * U), new BN(0)).accountsPartial(trade(bettor2, market)), [bettor2], "OtherSide");
    const pos1 = await program.account.position.fetch(positionPda(market, bettor1.publicKey));
    await mustFail("sell_more_than_held", program.methods.sellShares(pos1.shares.addn(1), new BN(0)).accountsPartial(trade(bettor1, market)), [bettor1], "NotEnoughShares");
    await mustFail("sell_slippage_guard", program.methods.sellShares(pos1.shares, new BN(1_000 * U)).accountsPartial(trade(bettor1, market)), [bettor1], "Slippage");
    await mustFail("buy_under_min", program.methods.buyShares(2, new BN(5 * U - 1), new BN(0)).accountsPartial(trade(bettor1, market)), [bettor1], "BadAmount");

    const before = await usdcBal(bettor1.publicKey);
    record("bettor1_cash_out_all_yes", await as(bettor1).methods.sellShares(pos1.shares, new BN(0)).accountsPartial(trade(bettor1, market)).rpc());
    const got = (await usdcBal(bettor1.publicKey)) - before;
    note("bettor1_cash_out_received", fmt(got));
    note("bettor1_profit", fmt(got - b1Paid));
    record("bettor1_buy_no_5", await as(bettor1).methods.buyShares(2, new BN(5 * U), new BN(0)).accountsPartial(trade(bettor1, market)).rpc());
  } else if (step === "resolve") {
    const market = new PublicKey(state.market);
    const r = as(resolver);
    record("resolver_lock", await r.methods.lockMarket().accountsPartial(ra(resolver, market)).rpc());
    await mustFail("buy_while_locked", program.methods.buyShares(1, new BN(5 * U), new BN(0)).accountsPartial(trade(bettor2, market)), [bettor2], "BadStatus");
    const pos2 = await program.account.position.fetch(positionPda(market, bettor2.publicKey));
    await mustFail("cash_out_while_locked", program.methods.sellShares(pos2.shares, new BN(0)).accountsPartial(trade(bettor2, market)), [bettor2], "BadStatus");
    await mustFail("resolver_resolve_no_early", r.methods.resolveMarket(2, new BN(0)).accountsPartial(ra(resolver, market)), [resolver], "TooEarly");
    await mustFail("resolver_void", program.methods.voidMarket().accountsPartial({ admin: resolver.publicKey, config: configPda, market }), [resolver], "Unauthorized");
    record("resolver_resolve_yes_early", await r.methods.resolveMarket(1, new BN(1_234_567)).accountsPartial(ra(resolver, market)).rpc());
  } else if (step === "claim") {
    const market = new PublicKey(state.market);
    const m = await program.account.market.fetch(market);
    note("pot_yes_reserve", fmt(m.yesReserve.toNumber()));
    note("pot_no_reserve", fmt(m.noReserve.toNumber()));
    for (const [name, k] of [["claim_bettor2_yes_winner", bettor2], ["claim_bettor1_no_loser", bettor1]] as const) {
      const before = await usdcBal(k.publicKey);
      record(name, await as(k).methods.claim().accountsPartial({ user: k.publicKey, config: configPda, market, vault: vaultPda(market),
        position: positionPda(market, k.publicKey), userUsdc: usdcOf(k.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).rpc());
      note(`${name}_received`, fmt((await usdcBal(k.publicKey)) - before));
    }
    const fv = (await program.account.config.fetch(configPda)).feeVault;
    const fb = (await getAccount(conn, fv)).amount;
    record("collect_fees", await program.methods.collectFees().accountsPartial({ caller: admin.publicKey, config: configPda, market, vault: vaultPda(market), feeVault: fv, tokenProgram: TOKEN_PROGRAM_ID }).rpc());
    note("fee_to_admin_wallet", fmt((await getAccount(conn, fv)).amount - fb));
    note("vault_left", fmt((await getAccount(conn, vaultPda(market))).amount));
    await mustFail("claim_twice", program.methods.claim().accountsPartial({ user: bettor2.publicKey, config: configPda, market, vault: vaultPda(market),
      position: positionPda(market, bettor2.publicKey), userUsdc: usdcOf(bettor2.publicKey), tokenProgram: TOKEN_PROGRAM_ID }), [bettor2], "AlreadyClaimed");
  } else if (step === "orphan") {
    // Everyone on one side cashes out, then the admin voids: holders get their side back,
    // the platform sweeps the sold out side's retained fees, vault ends at 0.
    const c = await program.account.config.fetch(configPda);
    let market: PublicKey;
    // Resume on a market this step already created and approved (an earlier run may have stopped part way).
    const existing = state.orphanMarket ? await program.account.market.fetchNullable(new PublicKey(state.orphanMarket)) : null;
    if (existing && existing.status.open) {
      market = new PublicKey(state.orphanMarket);
      console.log(`resuming on open market ${market.toBase58()}`);
    } else {
      market = marketPda(c.marketCount);
      state.orphanMarket = market.toBase58();
      save();
      const endTs = (await chainNow()) + 3600 + 120;
      record("orphan_create_bettor2_yes_5", await as(bettor2).methods
        .createMarket(new PublicKey("So11111111111111111111111111111111111111112"), 0, 0, new BN(1_000_000), 0, new BN(endTs), 1, new BN(5 * U), new BN(0))
        .accountsPartial({ creator: bettor2.publicKey, config: configPda, usdcMint: USDC, market, vault: vaultPda(market),
          position: positionPda(market, bettor2.publicKey), creatorUsdc: usdcOf(bettor2.publicKey), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .rpc());
      record("orphan_approve", await program.methods.approveMarket().accountsPartial({ admin: admin.publicKey, config: configPda, market }).rpc());
    }
    record("orphan_bettor1_buy_no_5", await as(bettor1).methods.buyShares(2, new BN(5 * U), new BN(0)).accountsPartial(trade(bettor1, market)).rpc());
    const pos1 = await program.account.position.fetch(positionPda(market, bettor1.publicKey));
    record("orphan_bettor1_sells_all_no", await as(bettor1).methods.sellShares(pos1.shares, new BN(0)).accountsPartial(trade(bettor1, market)).rpc());
    const m = await program.account.market.fetch(market);
    note("orphan_no_shares_left", m.noShares.toString());
    note("orphan_no_reserve_left_fees", fmt(m.noReserve.toNumber()));
    await mustFail("orphan_collect_while_open", program.methods.collectFees().accountsPartial({ caller: admin.publicKey, config: configPda, market, vault: vaultPda(market), feeVault: c.feeVault, tokenProgram: TOKEN_PROGRAM_ID }), [admin], "BadStatus");
    record("orphan_admin_void", await program.methods.voidMarket().accountsPartial({ admin: admin.publicKey, config: configPda, market }).rpc());
    for (const [name, k] of [["orphan_claim_bettor2_refund", bettor2], ["orphan_claim_bettor1_nothing", bettor1]] as const) {
      const before = await usdcBal(k.publicKey);
      record(name, await as(k).methods.claim().accountsPartial({ user: k.publicKey, config: configPda, market, vault: vaultPda(market),
        position: positionPda(market, k.publicKey), userUsdc: usdcOf(k.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).rpc());
      note(`${name}_received`, fmt((await usdcBal(k.publicKey)) - before));
    }
    const fb = (await getAccount(conn, c.feeVault)).amount;
    record("orphan_collect_fees_sweep", await program.methods.collectFees().accountsPartial({ caller: admin.publicKey, config: configPda, market, vault: vaultPda(market), feeVault: c.feeVault, tokenProgram: TOKEN_PROGRAM_ID }).rpc());
    note("orphan_swept_to_admin", fmt((await getAccount(conn, c.feeVault)).amount - fb));
    note("orphan_vault_left", fmt((await getAccount(conn, vaultPda(market))).amount));
  } else if (step === "status") {
    const m = await program.account.market.fetch(new PublicKey(state.market));
    console.log(JSON.stringify({ status: Object.keys(m.status)[0], endTs: m.endTs.toNumber(), disputeEnds: m.disputeEnds.toNumber(), now: await chainNow() }));
  }
}

main().catch((e) => { console.error(e?.error?.errorCode?.code ?? e?.message ?? e); process.exit(1); });
