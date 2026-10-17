// Devnet run 3: the resolver key locks and resolves, and cannot do admin actions.
// Usage: npx ts-node -P tsconfig.json scripts/devnet-resolver.ts <setup|create|checks|resolve|claim|status>
// Admin is 7TPunt (the user's wallet). Never prints secrets. Writes public results to devnet-run3.json.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, transfer } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import idl from "../target/idl/mememarkets.json";
import { Mememarkets } from "../target/types/mememarkets";

const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const U = 1_000_000;
const STATE = path.join(__dirname, "..", "devnet-run3.json");
const load = (dir: string, n: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana", dir, `${n}.json`), "utf8"))));
const admin = load("mememarkets-mainnet", "deployer"); // 7TPunt, devnet admin
const devnetDeployer = load("mememarkets-devnet", "deployer");
const resolver = load("mememarkets-devnet", "resolver");
const bettor1 = load("mememarkets-devnet", "bettor1");
const bettor2 = load("mememarkets-devnet", "bettor2");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" });
const program = new Program<Mememarkets>(idl as Mememarkets, provider);
const pid = program.programId;
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
const [resolverPda] = PublicKey.findProgramAddressSync([Buffer.from("resolver")], pid);
const marketPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], pid)[0];
const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], pid)[0];
const positionPda = (m: PublicKey, u: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], pid)[0];

const state: Record<string, any> = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { ok: {}, mustFail: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
const record = (name: string, sig: string) => { state.ok[name] = sig; save(); console.log(`${name}: ${sig}`); };
async function chainNow() { return Number((await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32)); }

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

const ra = (signer: Keypair, market: PublicKey, withResolver = true) =>
  ({ authority: signer.publicKey, config: configPda, resolverConfig: withResolver ? resolverPda : null, market });

async function main() {
  const step = process.argv[2];
  if (step === "setup") {
    record("set_resolver", await program.methods.setResolver(resolver.publicKey)
      .accountsPartial({ admin: admin.publicKey, config: configPda, resolverConfig: resolverPda, systemProgram: SystemProgram.programId }).rpc());
    console.log(`resolver is ${(await program.account.resolverConfig.fetch(resolverPda)).resolver.toBase58()}`);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: devnetDeployer.publicKey, toPubkey: resolver.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL }));
    record("fund_resolver_sol", await anchor.web3.sendAndConfirmTransaction(conn, tx, [devnetDeployer]));
    const from = getAssociatedTokenAddressSync(USDC, admin.publicKey);
    for (const [i, b] of [[1, bettor1], [2, bettor2]] as const) {
      const to = (await getOrCreateAssociatedTokenAccount(conn, admin, USDC, b.publicKey)).address;
      record(`fund_usdc_bettor${i}`, await transfer(conn, admin, from, to, admin, 5 * U));
    }
  } else if (step === "create") {
    const c = await program.account.config.fetch(configPda);
    const market = marketPda(c.marketCount);
    const endTs = (await chainNow()) + 3600 + 60;
    record("create_market", await program.methods
      .createMarket(new PublicKey("So11111111111111111111111111111111111111112"), 0, 0, new BN(1_000_000), 0, new BN(endTs), 1, new BN(5 * U))
      .accountsPartial({ creator: bettor1.publicKey, config: configPda, usdcMint: USDC, market, vault: vaultPda(market),
        position: positionPda(market, bettor1.publicKey), creatorUsdc: getAssociatedTokenAddressSync(USDC, bettor1.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([bettor1]).rpc());
    state.market = market.toBase58();
    save();
    record("approve_market_by_admin", await program.methods.approveMarket().accountsPartial({ admin: admin.publicKey, config: configPda, market }).rpc());
    record("place_bet", await program.methods.placeBet(2, new BN(5 * U))
      .accountsPartial({ user: bettor2.publicKey, config: configPda, market, vault: vaultPda(market), position: positionPda(market, bettor2.publicKey),
        userUsdc: getAssociatedTokenAddressSync(USDC, bettor2.publicKey), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([bettor2]).rpc());
  } else if (step === "checks") {
    const market = new PublicKey(state.market);
    const asR = { admin: resolver.publicKey, config: configPda };
    await mustFail("resolver_void", program.methods.voidMarket().accountsPartial({ ...asR, market }), [resolver], "Unauthorized");
    await mustFail("resolver_reject", program.methods.rejectMarket().accountsPartial({ ...asR, market }), [resolver], "Unauthorized");
    await mustFail("resolver_settle_dispute", program.methods.settleDispute(1).accountsPartial({ ...asR, market }), [resolver], "Unauthorized");
    await mustFail("resolver_pause", program.methods.setPaused(true).accountsPartial(asR), [resolver], "Unauthorized");
    await mustFail("resolver_set_limits", program.methods.setLimits(500, new BN(1), new BN(1), new BN(0)).accountsPartial(asR), [resolver], "Unauthorized");
    await mustFail("resolver_set_admin", program.methods.setAdmin(resolver.publicKey).accountsPartial(asR), [resolver], "Unauthorized");
    await mustFail("resolver_set_resolver", program.methods.setResolver(bettor1.publicKey)
      .accountsPartial({ ...asR, resolverConfig: resolverPda, systemProgram: SystemProgram.programId }), [resolver], "Unauthorized");
    await mustFail("bettor_lock", program.methods.lockMarket().accountsPartial(ra(bettor1, market)), [bettor1], "Unauthorized");
    await mustFail("resolver_lock_without_resolver_config", program.methods.lockMarket().accountsPartial(ra(resolver, market, false)), [resolver], "Unauthorized");
  } else if (step === "resolve") {
    const market = new PublicKey(state.market);
    const rp = new anchor.AnchorProvider(conn, new anchor.Wallet(resolver), { commitment: "confirmed" });
    const asResolver = new Program<Mememarkets>(idl as Mememarkets, rp);
    record("resolver_lock", await asResolver.methods.lockMarket().accountsPartial(ra(resolver, market)).rpc());
    await mustFail("resolver_bet_while_locked_by_bettor", program.methods.placeBet(2, new BN(5 * U))
      .accountsPartial({ user: bettor2.publicKey, config: configPda, market, vault: vaultPda(market), position: positionPda(market, bettor2.publicKey),
        userUsdc: getAssociatedTokenAddressSync(USDC, bettor2.publicKey), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }), [bettor2], "BadStatus");
    await mustFail("resolver_resolve_no_early", asResolver.methods.resolveMarket(2, new BN(0)).accountsPartial(ra(resolver, market)), [resolver], "TooEarly");
    record("resolver_unlock", await asResolver.methods.unlockMarket().accountsPartial(ra(resolver, market)).rpc());
    record("resolver_lock_again", await asResolver.methods.lockMarket().accountsPartial(ra(resolver, market)).rpc());
    record("resolver_resolve_yes", await asResolver.methods.resolveMarket(1, new BN(1_234_567)).accountsPartial(ra(resolver, market)).rpc());
  } else if (step === "claim") {
    const market = new PublicKey(state.market);
    for (const [name, b] of [["claim_winner", bettor1], ["claim_loser", bettor2]] as const) {
      const acct = getAssociatedTokenAddressSync(USDC, b.publicKey);
      const before = (await getAccount(conn, acct)).amount;
      record(name, await program.methods.claim()
        .accountsPartial({ user: b.publicKey, config: configPda, market, vault: vaultPda(market), position: positionPda(market, b.publicKey), userUsdc: acct, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([b]).rpc());
      const got = (await getAccount(conn, acct)).amount - before;
      state[`${name}_received`] = got.toString();
      save();
      console.log(`  received ${got}`);
    }
    const c = await program.account.config.fetch(configPda);
    const before = (await getAccount(conn, c.feeVault)).amount;
    record("collect_fees", await program.methods.collectFees()
      .accountsPartial({ caller: admin.publicKey, config: configPda, market, vault: vaultPda(market), feeVault: c.feeVault, tokenProgram: TOKEN_PROGRAM_ID }).rpc());
    state.fee = ((await getAccount(conn, c.feeVault)).amount - before).toString();
    state.vaultLeft = (await getAccount(conn, vaultPda(market))).amount.toString();
    save();
    console.log(`  fee ${state.fee}, vault left ${state.vaultLeft}`);
    await mustFail("claim_twice", program.methods.claim()
      .accountsPartial({ user: bettor1.publicKey, config: configPda, market, vault: vaultPda(market), position: positionPda(market, bettor1.publicKey),
        userUsdc: getAssociatedTokenAddressSync(USDC, bettor1.publicKey), tokenProgram: TOKEN_PROGRAM_ID }), [bettor1], "AlreadyClaimed");
  } else if (step === "status") {
    const m = await program.account.market.fetch(new PublicKey(state.market));
    console.log(JSON.stringify({ status: Object.keys(m.status)[0], endTs: m.endTs.toNumber(), disputeEnds: m.disputeEnds.toNumber(), now: await chainNow() }));
  }
}

main().catch((e) => { console.error(e?.error?.errorCode?.code ?? e?.message ?? e); process.exit(1); });
