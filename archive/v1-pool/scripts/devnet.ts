// Devnet helper. Usage: yarn ts-node scripts/devnet.ts <step>
// Steps: init | verify | fund | create | bet | resolve | claim | status
// Keys are read from ~/.config/solana/mememarkets-devnet. Never prints secrets.
// Public state (addresses, signatures) is written to devnet-state.json.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import idl from "../target/idl/mememarkets.json";
import { Mememarkets } from "../target/types/mememarkets";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Circle devnet USDC
const KEYS = path.join(os.homedir(), ".config/solana/mememarkets-devnet");
const STATE = path.join(__dirname, "..", "devnet-state.json");
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const U = 1_000_000;

const load = (n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${n}.json`), "utf8"))));
const deployer = load("deployer");
const feeWallet = load("fee-wallet");
const bettor1 = load("bettor1");
const bettor2 = load("bettor2");

const conn = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new Program<Mememarkets>(idl as Mememarkets, provider);
const pid = program.programId;

const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
const [programData] = PublicKey.findProgramAddressSync([pid.toBuffer()], BPF_UPGRADEABLE);
const marketPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], pid)[0];
const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], pid)[0];
const positionPda = (m: PublicKey, u: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], pid)[0];

const state: Record<string, any> = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
const record = (name: string, sig: string) => {
  state.signatures = state.signatures ?? {};
  state.signatures[name] = sig;
  save();
  console.log(`${name}: ${sig}`);
};
async function chainNow() {
  const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  return Number(info!.data.readBigInt64LE(32));
}
const ata = async (owner: PublicKey) => (await getOrCreateAssociatedTokenAccount(conn, deployer, USDC, owner)).address;

async function main() {
  const step = process.argv[2];
  if (step === "init") {
    const feeVault = await ata(feeWallet.publicKey);
    state.feeVault = feeVault.toBase58();
    save();
    const sig = await program.methods
      .initialize(100, new BN(5_000_000), new BN(500_000_000), new BN(86_400))
      .accountsPartial({ admin: deployer.publicKey, config: configPda, usdcMint: USDC, feeVault, program: pid, programData, systemProgram: SystemProgram.programId })
      .rpc();
    record("initialize", sig);
  } else if (step === "verify") {
    const c = await program.account.config.fetch(configPda);
    const want: [string, any, any][] = [
      ["admin", c.admin.toBase58(), deployer.publicKey.toBase58()],
      ["fee_vault", c.feeVault.toBase58(), state.feeVault],
      ["usdc_mint", c.usdcMint.toBase58(), USDC.toBase58()],
      ["fee_bps", c.feeBps, 100],
      ["min_bet", c.minBet.toString(), "5000000"],
      ["max_bet", c.maxBet.toString(), "500000000"],
      ["dispute_secs", c.disputeSecs.toString(), "86400"],
      ["paused", c.paused, false],
    ];
    let ok = true;
    for (const [k, got, exp] of want) {
      const pass = got === exp;
      ok &&= pass;
      console.log(`${pass ? "OK  " : "FAIL"} ${k} = ${got}${pass ? "" : ` (expected ${exp})`}`);
    }
    console.log(`     market_count = ${c.marketCount.toString()}`);
    console.log(`config ${configPda.toBase58()}`);
    if (!ok) process.exit(1);
  } else if (step === "fund") {
    // Send a little SOL and 6 test USDC to each bettor from the deployer.
    for (const b of [bettor1, bettor2]) {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: b.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
      record(`fund_sol_${b === bettor1 ? 1 : 2}`, await provider.sendAndConfirm(tx));
      const to = await ata(b.publicKey);
      record(`fund_usdc_${b === bettor1 ? 1 : 2}`, await transfer(conn, deployer, await ata(deployer.publicKey), to, deployer, 6 * U));
    }
  } else if (step === "create") {
    // Smoke market uses the current config dispute window (300 seconds).
    const setLimits = (d: number) =>
      program.methods.setLimits(100, new BN(5_000_000), new BN(500_000_000), new BN(d)).accountsPartial({ admin: deployer.publicKey, config: configPda }).rpc();
    const c = await program.account.config.fetch(configPda);
    const market = marketPda(c.marketCount);
    const endTs = (await chainNow()) + 3600 + 60; // program minimum is 1 hour
    const sig = await program.methods
      .createMarket(new PublicKey("So11111111111111111111111111111111111111112"), 0, 0, new BN(1_000_000), 0, new BN(endTs), 1, new BN(5 * U))
      .accountsPartial({
        creator: bettor1.publicKey, config: configPda, usdcMint: USDC, market, vault: vaultPda(market),
        position: positionPda(market, bettor1.publicKey), creatorUsdc: await ata(bettor1.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([bettor1])
      .rpc();
    record("create_market", sig);
    state.market = market.toBase58();
    state.endTs = endTs;
    save();
    record("approve_market", await program.methods.approveMarket().accountsPartial({ admin: deployer.publicKey, config: configPda, market }).rpc());
  } else if (step === "bet") {
    const market = new PublicKey(state.market);
    const sig = await program.methods
      .placeBet(2, new BN(5 * U))
      .accountsPartial({
        user: bettor2.publicKey, config: configPda, market, vault: vaultPda(market),
        position: positionPda(market, bettor2.publicKey), userUsdc: await ata(bettor2.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([bettor2])
      .rpc();
    record("place_bet", sig);
  } else if (step === "resolve") {
    const market = new PublicKey(state.market);
    record("resolve_market", await program.methods.resolveMarket(1, new BN(1_234_567)).accountsPartial({ authority: deployer.publicKey, config: configPda, resolverConfig: null, market }).rpc());
  } else if (step === "claim") {
    const market = new PublicKey(state.market);
    for (const [name, b] of [["claim_bettor1_winner", bettor1], ["claim_bettor2_loser", bettor2]] as const) {
      const acct = await ata(b.publicKey);
      const before = (await getAccount(conn, acct)).amount;
      const sig = await program.methods
        .claim()
        .accountsPartial({ user: b.publicKey, config: configPda, market, vault: vaultPda(market), position: positionPda(market, b.publicKey), userUsdc: acct, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([b])
        .rpc();
      record(name, sig);
      console.log(`  received ${(await getAccount(conn, acct)).amount - before}`);
    }
    const fv = new PublicKey(state.feeVault);
    const before = (await getAccount(conn, fv)).amount;
    const sig = await program.methods
      .collectFees()
      .accountsPartial({ caller: deployer.publicKey, config: configPda, market, vault: vaultPda(market), feeVault: fv, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    record("collect_fees", sig);
    console.log(`  fee ${(await getAccount(conn, fv)).amount - before}, vault left ${(await getAccount(conn, vaultPda(market))).amount}`);
  } else if (step === "negative") {
    // Each of these must fail on chain. Sent with preflight off so the failure is a real, visible transaction.
    const market = new PublicKey(state.market);
    const phase = process.argv[3] ?? "open";
    async function mustFail(name: string, builder: any, signers: Keypair[], code: string) {
      const tx: Transaction = await builder.transaction();
      tx.feePayer = signers[0].publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      tx.sign(...signers);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await conn.confirmTransaction(sig, "confirmed");
      const r = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const logs = (r?.meta?.logMessages ?? []).join("\n");
      const ok = !!r?.meta?.err && logs.includes(code);
      state.negative = state.negative ?? {};
      state.negative[name] = { sig, expected: code, pass: ok };
      save();
      console.log(`${ok ? "OK  " : "FAIL"} ${name} -> ${code}: ${sig}`);
      if (!ok) { console.log(logs); process.exitCode = 1; }
    }
    const betIx = (who: Keypair, side: number, amt: number) =>
      program.methods.placeBet(side, new BN(amt)).accountsPartial({
        user: who.publicKey, config: configPda, market, vault: vaultPda(market),
        position: positionPda(market, who.publicKey), userUsdc: getAssociatedTokenAddressSync(USDC, who.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      });
    const claimIx = (who: Keypair) =>
      program.methods.claim().accountsPartial({
        user: who.publicKey, config: configPda, market, vault: vaultPda(market),
        position: positionPda(market, who.publicKey), userUsdc: getAssociatedTokenAddressSync(USDC, who.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
      });
    if (phase === "open") {
      await mustFail("bet_other_side", betIx(bettor1, 2, 5 * U), [bettor1], "OtherSide");
      await mustFail("bet_under_min", betIx(bettor2, 2, 4_999_999), [bettor2], "BadAmount");
      await mustFail("bet_over_max", betIx(bettor2, 2, 501 * U), [bettor2], "OverMax");
      await mustFail("non_admin_resolve",
        program.methods.resolveMarket(1, new BN(0)).accountsPartial({ authority: bettor1.publicKey, config: configPda, resolverConfig: null, market }), [bettor1], "Unauthorized");
      await mustFail("resolve_no_before_deadline",
        program.methods.resolveMarket(2, new BN(0)).accountsPartial({ authority: deployer.publicKey, config: configPda, resolverConfig: null, market }), [deployer], "TooEarly");
      await mustFail("claim_while_open", claimIx(bettor1), [bettor1], "NotClaimable");
    } else if (phase === "lockflow") {
      const admin = (ix: "lockMarket" | "unlockMarket", signer: Keypair) =>
        program.methods[ix]().accountsPartial({ authority: signer.publicKey, config: configPda, resolverConfig: null, market });
      const ok = async (name: string, b: any) => record(name, await b.rpc());
      await mustFail("non_admin_lock", admin("lockMarket", bettor1), [bettor1], "Unauthorized");
      await ok("lock_market", admin("lockMarket", deployer));
      await mustFail("bet_while_locked", betIx(bettor2, 2, 5 * U), [bettor2], "BadStatus");
      await mustFail("non_admin_unlock", admin("unlockMarket", bettor1), [bettor1], "Unauthorized");
      await mustFail("resolve_no_while_locked_before_deadline",
        program.methods.resolveMarket(2, new BN(0)).accountsPartial({ authority: deployer.publicKey, config: configPda, resolverConfig: null, market }), [deployer], "TooEarly");
      await ok("unlock_market", admin("unlockMarket", deployer));
      await ok("lock_market_again", admin("lockMarket", deployer));
    } else if (phase === "closed") {
      await mustFail("bet_after_deadline", betIx(bettor2, 2, 5 * U), [bettor2], "BettingClosed");
    } else if (phase === "window") {
      await mustFail("claim_in_dispute_window", claimIx(bettor1), [bettor1], "NotClaimable");
    } else if (phase === "after") {
      await mustFail("claim_twice", claimIx(bettor1), [bettor1], "AlreadyClaimed");
      await mustFail("collect_fees_twice",
        program.methods.collectFees().accountsPartial({ caller: deployer.publicKey, config: configPda, market, vault: vaultPda(market), feeVault: new PublicKey(state.feeVault), tokenProgram: TOKEN_PROGRAM_ID }),
        [deployer], "AlreadyClaimed");
    }
  } else if (step === "set-admin") {
    const next = new PublicKey(process.argv[3]);
    record("set_admin", await program.methods.setAdmin(next).accountsPartial({ admin: deployer.publicKey, config: configPda }).rpc());
    console.log(`admin is now ${(await program.account.config.fetch(configPda)).admin.toBase58()}`);
  } else if (step === "status") {
    const m = await program.account.market.fetch(new PublicKey(state.market));
    console.log(JSON.stringify({ status: Object.keys(m.status)[0], yes: m.yesPool.toString(), no: m.noPool.toString(), endTs: m.endTs.toNumber(), disputeEnds: m.disputeEnds.toNumber(), now: await chainNow() }));
  } else {
    console.log("steps: init | verify | fund | create | bet | resolve | claim | status");
  }
}

main().catch((e) => {
  console.error(e?.error?.errorCode?.code ?? e?.message ?? e);
  process.exit(1);
});
