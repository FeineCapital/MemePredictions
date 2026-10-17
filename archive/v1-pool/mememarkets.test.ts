// Integration tests. Run against the short-time test build:
//   ./scripts/build.sh test && anchor test --skip-build
// In that build MIN_DURATION is 2s and EMERGENCY_DELAY is 6s so deadlines and the 14 day valve can be exercised.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { Mememarkets } from "../target/types/mememarkets";

const U = 1_000_000; // 1 USDC
const YES = 1;
const NO = 2;
const VOID = 3;
const FEE_BPS = 100;
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

describe("mememarkets", () => {
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(envProvider.connection.rpcEndpoint, "confirmed"),
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const program = new Program<Mememarkets>(anchor.workspace.Mememarkets.idl, provider);
  const conn = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_UPGRADEABLE);

  let usdc: PublicKey;
  let feeVault: PublicKey;
  const feeWallet = Keypair.generate();
  const creator = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const carol = Keypair.generate();
  const outsider = Keypair.generate();
  const ata = new Map<string, PublicKey>();
  const usdcOf = (k: Keypair) => ata.get(k.publicKey.toBase58())!;

  // Ledger of every deposit and payout across all markets, for the global solvency assertion.
  let totalDeposited = 0n;
  let totalPaid = 0n;
  let totalFees = 0n;

  // ───────── helpers ─────────

  const marketPda = (id: number | BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("market"), new BN(id).toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  const vaultPda = (market: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], program.programId)[0];
  const positionPda = (market: PublicKey, user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), market.toBuffer(), user.toBuffer()],
      program.programId
    )[0];

  async function chainNow(): Promise<number> {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
    return Number(info!.data.readBigInt64LE(32));
  }
  async function waitUntil(ts: number) {
    while ((await chainNow()) <= ts) await new Promise((r) => setTimeout(r, 400));
  }
  async function bal(acct: PublicKey): Promise<bigint> {
    return (await getAccount(conn, acct, "confirmed")).amount;
  }
  async function expectErr(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (e: any) {
      const got = e?.error?.errorCode?.code ?? e?.message ?? String(e);
      expect(String(got)).to.include(code, `expected ${code}, got ${got}`);
      return;
    }
    assert.fail(`expected error ${code} but transaction succeeded`);
  }

  // Off chain mirror of payout_for in lib.rs, used to check exact payouts.
  function expectedPayout(stake: bigint, side: number, result: number, yes: bigint, no: bigint): bigint {
    const total = yes + no;
    const [win, lose] = result === YES ? [yes, no] : [no, yes];
    if (win === 0n || lose === 0n) return stake;
    if (side !== result) return 0n;
    return stake + (stake * (lose - expectedFee(yes, no, result))) / win;
  }
  function expectedFee(yes: bigint, no: bigint, result: number): bigint {
    const [win, lose] = result === YES ? [yes, no] : [no, yes];
    if (win === 0n || lose === 0n) return 0n;
    const f = ((yes + no) * BigInt(FEE_BPS)) / 10_000n;
    return f < lose ? f : lose;
  }

  /** Vault must always cover every unclaimed owed amount plus the uncollected fee. */
  async function assertSolvent(market: PublicKey, users: Keypair[]) {
    const m = await program.account.market.fetch(market);
    const vault = await bal(vaultPda(market));
    const yes = BigInt(m.yesPool.toString());
    const no = BigInt(m.noPool.toString());
    let owed = 0n;
    for (const u of users) {
      const p = await program.account.position.fetchNullable(positionPda(market, u.publicKey));
      if (!p || p.claimed) continue;
      const stake = BigInt(p.amount.toString());
      if (m.status.resolved) owed += expectedPayout(stake, p.side, m.result, yes, no);
      else owed += stake; // open, pending, void, rejected: worst case is a full refund
    }
    if (m.status.resolved && !m.feeCollected) owed += expectedFee(yes, no, m.result);
    assert(vault >= owed, `vault ${vault} < owed ${owed}`);
  }

  async function createMarket(who: Keypair, side: number, amount: number, secs: number) {
    const cfg = await program.account.config.fetch(configPda);
    const market = marketPda(cfg.marketCount);
    const endTs = (await chainNow()) + secs;
    await program.methods
      .createMarket(Keypair.generate().publicKey, 0, 0, new BN(1_000_000), 0, new BN(endTs), side, new BN(amount))
      .accountsPartial({
        creator: who.publicKey,
        config: configPda,
        usdcMint: usdc,
        market,
        vault: vaultPda(market),
        position: positionPda(market, who.publicKey),
        creatorUsdc: usdcOf(who),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who])
      .rpc();
    totalDeposited += BigInt(amount);
    return { market, endTs };
  }

  const review = (ix: "approveMarket" | "rejectMarket" | "voidMarket", market: PublicKey, signer = admin) =>
    program.methods[ix]()
      .accountsPartial({ admin: signer.publicKey, config: configPda, market })
      .signers([signer])
      .rpc();

  async function bet(who: Keypair, market: PublicKey, side: number, amount: number) {
    await program.methods
      .placeBet(side, new BN(amount))
      .accountsPartial({
        user: who.publicKey,
        config: configPda,
        market,
        vault: vaultPda(market),
        position: positionPda(market, who.publicKey),
        userUsdc: usdcOf(who),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who])
      .rpc();
    totalDeposited += BigInt(amount);
  }

  const [resolverPda] = PublicKey.findProgramAddressSync([Buffer.from("resolver")], program.programId);
  // lock, unlock and resolve take the admin or the resolver. resolverConfig is optional (null when the admin signs).
  const resolverIx = (ix: "lockMarket" | "unlockMarket", market: PublicKey, signer = admin, withResolver = false) =>
    program.methods[ix]()
      .accountsPartial({ authority: signer.publicKey, config: configPda, resolverConfig: withResolver ? resolverPda : null, market })
      .signers([signer])
      .rpc();
  const resolve = (market: PublicKey, result: number, signer = admin, withResolver = false) =>
    program.methods
      .resolveMarket(result, new BN(123_456))
      .accountsPartial({ authority: signer.publicKey, config: configPda, resolverConfig: withResolver ? resolverPda : null, market })
      .signers([signer])
      .rpc();

  const settle = (market: PublicKey, result: number, signer = admin) =>
    program.methods
      .settleDispute(result)
      .accountsPartial({ admin: signer.publicKey, config: configPda, market })
      .signers([signer])
      .rpc();

  const dispute = (who: Keypair, market: PublicKey) =>
    program.methods
      .disputeMarket()
      .accountsPartial({ user: who.publicKey, market, position: positionPda(market, who.publicKey) })
      .signers([who])
      .rpc();

  const emergencyVoid = (who: Keypair, market: PublicKey) =>
    program.methods.emergencyVoid().accountsPartial({ caller: who.publicKey, market }).signers([who]).rpc();

  /** Claims and returns the amount received. */
  async function claim(who: Keypair, market: PublicKey): Promise<bigint> {
    const before = await bal(usdcOf(who));
    await program.methods
      .claim()
      .accountsPartial({
        user: who.publicKey,
        config: configPda,
        market,
        vault: vaultPda(market),
        position: positionPda(market, who.publicKey),
        userUsdc: usdcOf(who),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who])
      .rpc();
    const got = (await bal(usdcOf(who))) - before;
    totalPaid += got;
    return got;
  }

  async function collectFees(market: PublicKey): Promise<bigint> {
    const before = await bal(feeVault);
    await program.methods
      .collectFees()
      .accountsPartial({
        caller: outsider.publicKey,
        config: configPda,
        market,
        vault: vaultPda(market),
        feeVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([outsider])
      .rpc();
    const got = (await bal(feeVault)) - before;
    totalFees += got;
    return got;
  }

  const setLimits = (disputeSecs: number, signer = admin) =>
    program.methods
      .setLimits(FEE_BPS, new BN(5 * U), new BN(500 * U), new BN(disputeSecs))
      .accountsPartial({ admin: signer.publicKey, config: configPda })
      .signers([signer])
      .rpc();

  const setPaused = (paused: boolean, signer = admin) =>
    program.methods
      .setPaused(paused)
      .accountsPartial({ admin: signer.publicKey, config: configPda })
      .signers([signer])
      .rpc();

  // ───────── setup ─────────

  before(async () => {
    for (const k of [feeWallet, creator, alice, bob, carol, outsider]) {
      const sig = await conn.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    }
    usdc = await createMint(conn, admin, admin.publicKey, null, 6);
    feeVault = await createAssociatedTokenAccount(conn, admin, usdc, feeWallet.publicKey);
    for (const k of [creator, alice, bob, carol, outsider]) {
      const a = await createAssociatedTokenAccount(conn, admin, usdc, k.publicKey);
      ata.set(k.publicKey.toBase58(), a);
      await mintTo(conn, admin, usdc, a, admin, 10_000 * U);
    }
  });

  // ───────── initialize and admin controls ─────────

  const initIx = (signer: Keypair, disputeSecs = 3, mint?: PublicKey) =>
    program.methods
      .initialize(FEE_BPS, new BN(5 * U), new BN(500 * U), new BN(disputeSecs))
      .accountsPartial({
        admin: signer.publicKey,
        config: configPda,
        usdcMint: mint ?? usdc,
        feeVault,
        program: program.programId,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .signers([signer]);

  it("initialize: rejects a signer that is not the upgrade authority (front run guard)", async () => {
    await expectErr(initIx(outsider).rpc(), "Unauthorized");
  });

  it("initialize: rejects a dispute window over 7 days", async () => {
    await expectErr(initIx(admin, 8 * 24 * 3600).rpc(), "BadConfig");
  });

  it("initialize: rejects a mint that is not 6 decimals", async () => {
    const nine = await createMint(conn, admin, admin.publicKey, null, 9);
    await expectErr(initIx(admin, 3, nine).rpc(), "BadConfig");
  });

  it("initialize: upgrade authority sets config and every field matches", async () => {
    await initIx(admin).rpc();
    const c = await program.account.config.fetch(configPda);
    assert(c.admin.equals(admin.publicKey));
    assert(c.feeVault.equals(feeVault));
    assert(c.usdcMint.equals(usdc));
    expect(c.feeBps).to.eq(FEE_BPS);
    expect(c.minBet.toNumber()).to.eq(5 * U);
    expect(c.maxBet.toNumber()).to.eq(500 * U);
    expect(c.disputeSecs.toNumber()).to.eq(3);
    expect(c.marketCount.toNumber()).to.eq(0);
    expect(c.paused).to.eq(false);
  });

  it("initialize: cannot run twice", async () => {
    await expectErr(initIx(admin).rpc(), "already in use");
  });

  it("admin controls: non admin cannot pause, set limits or set admin", async () => {
    await expectErr(setPaused(true, outsider), "Unauthorized");
    await expectErr(setLimits(3, outsider), "Unauthorized");
    await expectErr(
      program.methods.setAdmin(outsider.publicKey).accountsPartial({ admin: outsider.publicKey, config: configPda }).signers([outsider]).rpc(),
      "Unauthorized"
    );
  });

  it("admin controls: set_limits rejects bad values, set_admin rejects the zero key, set_admin hands over and back", async () => {
    await expectErr(setLimits(8 * 24 * 3600), "BadConfig");
    await expectErr(
      program.methods.setAdmin(PublicKey.default).accountsPartial({ admin: admin.publicKey, config: configPda }).signers([admin]).rpc(),
      "BadConfig"
    );
    await program.methods.setAdmin(carol.publicKey).accountsPartial({ admin: admin.publicKey, config: configPda }).signers([admin]).rpc();
    assert((await program.account.config.fetch(configPda)).admin.equals(carol.publicKey));
    await expectErr(setPaused(false, admin), "Unauthorized");
    await program.methods.setAdmin(admin.publicKey).accountsPartial({ admin: carol.publicKey, config: configPda }).signers([carol]).rpc();
    assert((await program.account.config.fetch(configPda)).admin.equals(admin.publicKey));
  });

  it("create_market: enforces min, max, side and deadline", async () => {
    await expectErr(createMarket(creator, YES, 5 * U - 1, 10), "BadAmount");
    await expectErr(createMarket(creator, YES, 500 * U + 1, 10), "BadAmount");
    await expectErr(createMarket(creator, 3, 10 * U, 10), "BadSide");
    await expectErr(createMarket(creator, YES, 10 * U, 1), "BadDeadline");
    totalDeposited = 0n; // failed attempts above did not deposit
  });

  // ───────── main flow ─────────

  describe("two sided market resolved Yes", () => {
    let market: PublicKey;
    let endTs: number;
    const users = [creator, alice, bob, carol];

    it("create, non admin cannot approve, admin approves", async () => {
      await setLimits(6);
      ({ market, endTs } = await createMarket(creator, YES, 100 * U, 14));
      await setLimits(3);
      const m = await program.account.market.fetch(market);
      expect(m.disputeSecs.toNumber()).to.eq(6, "dispute window is snapshotted at creation");
      expect(m.feeBps).to.eq(FEE_BPS);
      assert(m.status.pending);
      await expectErr(bet(alice, market, YES, 10 * U), "BadStatus");
      await expectErr(review("approveMarket", market, outsider), "Unauthorized");
      await review("approveMarket", market);
      assert((await program.account.market.fetch(market)).status.open);
      await expectErr(review("approveMarket", market), "BadStatus");
    });

    it("bets on both sides with limits enforced", async () => {
      await bet(alice, market, YES, 50 * U);
      await bet(alice, market, YES, 20 * U); // top up same side
      await bet(bob, market, NO, 80 * U);
      await bet(carol, market, NO, 40 * U);
      await expectErr(bet(alice, market, NO, 10 * U), "OtherSide");
      await expectErr(bet(bob, market, NO, 421 * U), "OverMax"); // 80 + 421 > 500
      await bet(bob, market, NO, 420 * U); // exactly 500 is allowed
      await expectErr(bet(carol, market, NO, 5 * U - 1), "BadAmount");
      await expectErr(bet(alice, market, 0, 10 * U), "BadSide");
      const m = await program.account.market.fetch(market);
      expect(m.yesPool.toNumber()).to.eq(170 * U);
      expect(m.noPool.toNumber()).to.eq(540 * U);
      expect(Number(await bal(vaultPda(market)))).to.eq(710 * U);
      await assertSolvent(market, users);
    });

    it("cannot resolve No or Void early, cannot bet after the deadline, non admin cannot resolve", async () => {
      await expectErr(resolve(market, NO), "TooEarly");
      await expectErr(resolve(market, VOID), "TooEarly");
      await expectErr(claim(alice, market), "NotClaimable");
      await waitUntil(endTs);
      await expectErr(bet(carol, market, NO, 10 * U), "BettingClosed");
      await expectErr(resolve(market, YES, outsider), "Unauthorized");
      await expectErr(resolve(market, 4), "BadParams");
    });

    it("resolve Yes, no claims or fees during the dispute window", async () => {
      await resolve(market, YES);
      const m = await program.account.market.fetch(market);
      assert(m.status.resolved);
      expect(m.result).to.eq(YES);
      expect(m.finalValue.toNumber()).to.eq(123_456);
      expect(m.disputeEnds.toNumber()).to.eq(m.resolvedTs.toNumber() + 6);
      await expectErr(claim(creator, market), "NotClaimable");
      await expectErr(collectFees(market), "NotClaimable");
      await expectErr(resolve(market, NO), "BadStatus");
      await assertSolvent(market, users);
    });

    it("winners get exact payout, loser gets 0, no double claim", async () => {
      const m = await program.account.market.fetch(market);
      await waitUntil(m.disputeEnds.toNumber() - 1);
      const yes = 170n * BigInt(U);
      const no = 540n * BigInt(U);
      const c = await claim(creator, market);
      expect(c).to.eq(expectedPayout(100n * BigInt(U), YES, YES, yes, no));
      // stake + stake / winning pool x (losing pool - fee) = 100 + 100/170 x (540 - 7.1)
      expect(c).to.eq(100n * BigInt(U) + (100n * BigInt(U) * 532_900_000n) / (170n * BigInt(U)));
      await assertSolvent(market, users);
      const a = await claim(alice, market);
      expect(a).to.eq(70n * BigInt(U) + (70n * BigInt(U) * 532_900_000n) / (170n * BigInt(U)));
      expect(await claim(bob, market)).to.eq(0n);
      expect(await claim(carol, market)).to.eq(0n);
      assert((await program.account.position.fetch(positionPda(market, bob.publicKey))).claimed);
      await expectErr(claim(alice, market), "AlreadyClaimed");
      await expectErr(claim(bob, market), "AlreadyClaimed");
      await assertSolvent(market, users);
    });

    it("no dispute after the window", async () => {
      await expectErr(dispute(bob, market), "DisputeClosed");
    });

    it("collect_fees pays exactly 1 percent once", async () => {
      const fee = await collectFees(market);
      expect(fee).to.eq((710n * BigInt(U) * 100n) / 10_000n);
      expect(fee).to.eq(7_100_000n);
      await expectErr(collectFees(market), "AlreadyClaimed");
      const left = await bal(vaultPda(market));
      // Only rounding dust can remain, and paid + fee never exceed the deposits.
      const paid = 710n * BigInt(U) - left - fee;
      assert(paid + fee <= 710n * BigInt(U));
      assert(left < 10n, `dust ${left}`);
    });
  });

  describe("lock and early Yes resolution (target hit before the deadline)", () => {
    it("non admin cannot lock or unlock, Yes from Open before the deadline is rejected", async () => {
      const { market } = await createMarket(creator, YES, 10 * U, 3600);
      await review("approveMarket", market);
      await expectErr(resolve(market, YES), "TooEarly"); // must lock first
      await expectErr(resolverIx("lockMarket", market, outsider), "Unauthorized");
      await expectErr(resolverIx("unlockMarket", market), "BadStatus"); // not locked
      await resolverIx("lockMarket", market);
      await expectErr(resolverIx("unlockMarket", market, outsider), "Unauthorized");
      await expectErr(resolverIx("lockMarket", market), "BadStatus"); // already locked
      await review("voidMarket", market); // admin can void a locked market
      expect(await claim(creator, market)).to.eq(10n * BigInt(U));
    });

    it("lock stops bets, unlock reopens them (false alarm)", async () => {
      const { market } = await createMarket(creator, YES, 10 * U, 3600);
      await review("approveMarket", market);
      await resolverIx("lockMarket", market);
      const m = await program.account.market.fetch(market);
      assert(m.status.locked);
      assert(m.resolvedTs.toNumber() > 0, "lock time recorded");
      await expectErr(bet(bob, market, NO, 10 * U), "BadStatus");
      await expectErr(claim(creator, market), "NotClaimable");
      await resolverIx("unlockMarket", market);
      assert((await program.account.market.fetch(market)).status.open);
      await bet(bob, market, NO, 10 * U);
      await review("voidMarket", market);
      expect(await claim(creator, market)).to.eq(10n * BigInt(U));
      expect(await claim(bob, market)).to.eq(10n * BigInt(U));
    });

    it("resolve Yes from Locked before the deadline, No still rejected, winners claim after the window", async () => {
      await setLimits(3);
      const { market, endTs } = await createMarket(creator, YES, 20 * U, 3600); // deadline an hour away
      await review("approveMarket", market);
      await bet(bob, market, NO, 30 * U);
      await resolverIx("lockMarket", market);
      await expectErr(resolve(market, NO), "TooEarly");
      await expectErr(resolve(market, VOID), "TooEarly");
      await expectErr(resolve(market, YES, outsider), "Unauthorized");
      await resolve(market, YES);
      const m = await program.account.market.fetch(market);
      assert(m.status.resolved);
      assert(m.resolvedTs.toNumber() < endTs, "resolved before the deadline");
      await expectErr(bet(alice, market, YES, 10 * U), "BadStatus");
      await expectErr(resolverIx("unlockMarket", market), "BadStatus");
      await expectErr(claim(creator, market), "NotClaimable");
      await waitUntil(m.disputeEnds.toNumber() - 1);
      expect(await claim(creator, market)).to.eq(20n * BigInt(U) + 29_500_000n); // 20 + (30 - 0.5 fee)
      expect(await claim(bob, market)).to.eq(0n);
      expect(await collectFees(market)).to.eq(500_000n);
      expect(await bal(vaultPda(market))).to.eq(0n);
    });

    it("locked market: unlock fails after the deadline, resolve No works after the deadline", async () => {
      const { market, endTs } = await createMarket(creator, YES, 10 * U, 4);
      await review("approveMarket", market);
      await bet(bob, market, NO, 10 * U);
      await resolverIx("lockMarket", market);
      await waitUntil(endTs);
      await expectErr(resolverIx("unlockMarket", market), "DeadlinePassed");
      await resolve(market, NO);
      await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() - 1);
      expect(await claim(bob, market)).to.eq(10n * BigInt(U) + 9_800_000n);
      expect(await claim(creator, market)).to.eq(0n);
      expect(await collectFees(market)).to.eq(200_000n);
    });

    it("emergency_void covers a market stuck in Locked", async () => {
      const { market } = await createMarket(creator, YES, 10 * U, 3600); // deadline far away
      await review("approveMarket", market);
      await bet(bob, market, NO, 10 * U);
      await resolverIx("lockMarket", market);
      const lockedAt = (await program.account.market.fetch(market)).resolvedTs.toNumber();
      await expectErr(emergencyVoid(outsider, market), "TooEarly");
      await waitUntil(lockedAt + 6); // EMERGENCY_DELAY in the test build
      await emergencyVoid(outsider, market);
      expect(await claim(creator, market)).to.eq(10n * BigInt(U));
      expect(await claim(bob, market)).to.eq(10n * BigInt(U));
    });
  });

  describe("lopsided pool (losing side under 1 percent)", () => {
    it("fee is capped at the losing pool and every winner gets at least their stake", async () => {
      const { market, endTs } = await createMarket(creator, YES, 500 * U, 6);
      await review("approveMarket", market);
      await bet(alice, market, YES, 500 * U);
      await bet(bob, market, YES, 490 * U);
      await bet(carol, market, NO, 5 * U); // 5 vs 1490: 0.34 percent
      await waitUntil(endTs);
      await resolve(market, YES);
      await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() - 1);
      await assertSolvent(market, [creator, alice, bob, carol]);
      const stakes: [Keypair, bigint][] = [[creator, 500n], [alice, 500n], [bob, 490n]];
      let paid = 0n;
      for (const [who, s] of stakes) {
        const got = await claim(who, market);
        assert(got >= s * BigInt(U), `winner got ${got} for stake ${s * BigInt(U)}`);
        paid += got;
      }
      expect(await claim(carol, market)).to.eq(0n);
      const fee = await collectFees(market);
      expect(fee).to.eq(5n * BigInt(U)); // min(14.95, 5)
      const pool = 1495n * BigInt(U);
      assert(paid + fee <= pool, `paid ${paid} + fee ${fee} > pool ${pool}`);
      expect(await bal(vaultPda(market))).to.eq(pool - paid - fee);
    });
  });

  describe("dispute and settle", () => {
    let market: PublicKey;
    let endTs: number;

    it("bettor disputes, claims freeze, admin settles to No", async () => {
      await setLimits(30);
      ({ market, endTs } = await createMarket(creator, YES, 60 * U, 6));
      await setLimits(3);
      await review("approveMarket", market);
      await bet(bob, market, NO, 40 * U);
      await waitUntil(endTs);
      await resolve(market, YES);
      await expectErr(dispute(outsider, market), "AccountNotInitialized"); // no position, cannot dispute
      await expectErr(settle(market, NO), "BadStatus"); // nothing to settle yet
      await dispute(bob, market);
      await expectErr(dispute(creator, market), "BadStatus");
      await expectErr(claim(creator, market), "NotClaimable");
      await expectErr(collectFees(market), "NotClaimable");
      await expectErr(emergencyVoid(outsider, market), "TooEarly");
      await expectErr(settle(market, NO, outsider), "Unauthorized");
      await settle(market, NO);
      const m = await program.account.market.fetch(market);
      expect(m.result).to.eq(NO);
      expect(m.disputed).to.eq(false);
      await expectErr(dispute(creator, market), "DisputeClosed");
      expect(await claim(creator, market)).to.eq(0n);
      expect(await claim(bob, market)).to.eq(40n * BigInt(U) + 59n * BigInt(U)); // 40 + (60 - 1 fee)
      expect(await collectFees(market)).to.eq(1_000_000n);
      await assertSolvent(market, [creator, bob]);
    });
  });

  describe("refund paths", () => {
    it("one sided market refunds in full with no fee", async () => {
      const { market, endTs } = await createMarket(creator, YES, 50 * U, 5);
      await review("approveMarket", market);
      await bet(alice, market, YES, 30 * U);
      await waitUntil(endTs);
      await resolve(market, YES);
      await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() - 1);
      expect(await claim(creator, market)).to.eq(50n * BigInt(U));
      expect(await claim(alice, market)).to.eq(30n * BigInt(U));
      expect(await collectFees(market)).to.eq(0n);
      assert((await program.account.market.fetch(market)).feeCollected);
      expect(await bal(vaultPda(market))).to.eq(0n);
    });

    it("one sided market resolved for the empty side also refunds in full", async () => {
      const { market, endTs } = await createMarket(creator, YES, 20 * U, 4);
      await review("approveMarket", market);
      await waitUntil(endTs);
      await resolve(market, NO);
      await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() - 1);
      expect(await claim(creator, market)).to.eq(20n * BigInt(U));
      expect(await collectFees(market)).to.eq(0n);
    });

    it("void_market refunds everyone, no fee, cannot resolve after", async () => {
      const { market } = await createMarket(creator, YES, 25 * U, 60);
      await review("approveMarket", market);
      await bet(alice, market, YES, 15 * U);
      await bet(bob, market, NO, 35 * U);
      await expectErr(review("voidMarket", market, outsider), "Unauthorized");
      await review("voidMarket", market);
      await expectErr(resolve(market, YES), "BadStatus");
      await expectErr(bet(carol, market, NO, 10 * U), "BadStatus");
      await assertSolvent(market, [creator, alice, bob]);
      expect(await claim(creator, market)).to.eq(25n * BigInt(U));
      expect(await claim(alice, market)).to.eq(15n * BigInt(U));
      expect(await claim(bob, market)).to.eq(35n * BigInt(U));
      await expectErr(claim(bob, market), "AlreadyClaimed");
      await expectErr(collectFees(market), "BadStatus");
      expect(await bal(vaultPda(market))).to.eq(0n);
    });

    it("resolve with Void result refunds everyone", async () => {
      const { market, endTs } = await createMarket(creator, NO, 10 * U, 4);
      await review("approveMarket", market);
      await bet(alice, market, YES, 10 * U);
      await waitUntil(endTs);
      await resolve(market, VOID);
      assert((await program.account.market.fetch(market)).status.void);
      expect(await claim(creator, market)).to.eq(10n * BigInt(U));
      expect(await claim(alice, market)).to.eq(10n * BigInt(U));
    });

    it("rejected market refunds the creator", async () => {
      const { market } = await createMarket(creator, YES, 40 * U, 60);
      await expectErr(review("rejectMarket", market, outsider), "Unauthorized");
      await review("rejectMarket", market);
      assert((await program.account.market.fetch(market)).status.rejected);
      await expectErr(review("approveMarket", market), "BadStatus");
      expect(await claim(creator, market)).to.eq(40n * BigInt(U));
      await expectErr(claim(creator, market), "AlreadyClaimed");
    });

    it("cancel_pending refunds the creator, only the creator can cancel", async () => {
      const { market } = await createMarket(creator, NO, 12 * U, 60);
      await expectErr(
        program.methods.cancelPending().accountsPartial({ creator: outsider.publicKey, market }).signers([outsider]).rpc(),
        "Unauthorized"
      );
      await program.methods.cancelPending().accountsPartial({ creator: creator.publicKey, market }).signers([creator]).rpc();
      await expectErr(
        program.methods.cancelPending().accountsPartial({ creator: creator.publicKey, market }).signers([creator]).rpc(),
        "BadStatus"
      );
      expect(await claim(creator, market)).to.eq(12n * BigInt(U));
    });
  });

  describe("emergency_void", () => {
    it("anyone can void an open market the admin never resolved, after the delay", async () => {
      const { market, endTs } = await createMarket(creator, YES, 30 * U, 4);
      await review("approveMarket", market);
      await bet(bob, market, NO, 20 * U);
      await waitUntil(endTs);
      await expectErr(emergencyVoid(outsider, market), "TooEarly");
      await waitUntil(endTs + 6); // EMERGENCY_DELAY in the test build
      await emergencyVoid(outsider, market);
      assert((await program.account.market.fetch(market)).status.void);
      expect(await claim(creator, market)).to.eq(30n * BigInt(U));
      expect(await claim(bob, market)).to.eq(20n * BigInt(U));
    });

    it("anyone can void a dispute the admin never settled, after the delay", async () => {
      await setLimits(3);
      const { market, endTs } = await createMarket(creator, YES, 30 * U, 4);
      await review("approveMarket", market);
      await bet(bob, market, NO, 20 * U);
      await waitUntil(endTs);
      await resolve(market, YES);
      await dispute(bob, market);
      const m = await program.account.market.fetch(market);
      await expectErr(emergencyVoid(outsider, market), "TooEarly");
      await waitUntil(m.disputeEnds.toNumber() + 6);
      await emergencyVoid(outsider, market);
      expect(await claim(creator, market)).to.eq(30n * BigInt(U));
      expect(await claim(bob, market)).to.eq(20n * BigInt(U));
    });

    it("cannot emergency void a resolved, undisputed market", async () => {
      const { market, endTs } = await createMarket(creator, YES, 10 * U, 3);
      await review("approveMarket", market);
      await bet(bob, market, NO, 10 * U);
      await waitUntil(endTs);
      await resolve(market, NO);
      await waitUntil(endTs + 8);
      await expectErr(emergencyVoid(outsider, market), "TooEarly");
      await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber());
      expect(await claim(bob, market)).to.eq(10n * BigInt(U) + 9_800_000n); // 10 + (10 - 0.2 fee)
      expect(await collectFees(market)).to.eq(200_000n);
    });
  });

  describe("pause", () => {
    it("blocks new bets and markets but not claims", async () => {
      const { market } = await createMarket(creator, YES, 10 * U, 60);
      await review("approveMarket", market);
      await bet(alice, market, NO, 10 * U);
      await setPaused(true);
      await expectErr(bet(bob, market, NO, 10 * U), "Paused");
      await expectErr(createMarket(creator, YES, 10 * U, 60), "Paused");
      await review("voidMarket", market);
      expect(await claim(alice, market)).to.eq(10n * BigInt(U));
      expect(await claim(creator, market)).to.eq(10n * BigInt(U));
      await setPaused(false);
      const { market: m2 } = await createMarket(creator, YES, 10 * U, 60);
      await review("approveMarket", m2);
      await bet(bob, m2, NO, 10 * U); // betting works again after unpause
    });
  });

  describe("resolver role (price watcher key)", () => {
    const resolver = Keypair.generate();
    const setResolver = (key: PublicKey, signer = admin) =>
      program.methods
        .setResolver(key)
        .accountsPartial({ admin: signer.publicKey, config: configPda, resolverConfig: resolverPda, systemProgram: SystemProgram.programId })
        .signers([signer])
        .rpc();

    before(async () => {
      const sig = await conn.requestAirdrop(resolver.publicKey, 2 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    });

    it("only the admin can set the resolver", async () => {
      await expectErr(setResolver(resolver.publicKey, outsider), "Unauthorized");
      await setResolver(resolver.publicKey);
      const r = await program.account.resolverConfig.fetch(resolverPda);
      assert(r.resolver.equals(resolver.publicKey));
    });

    it("resolver can lock, unlock and resolve Yes early, and a payout follows", async () => {
      await setLimits(3);
      const { market } = await createMarket(creator, YES, 10 * U, 3600);
      await expectErr(
        program.methods.approveMarket().accountsPartial({ admin: resolver.publicKey, config: configPda, market }).signers([resolver]).rpc(),
        "Unauthorized"
      );
      await review("approveMarket", market);
      await bet(bob, market, NO, 10 * U);
      await resolverIx("lockMarket", market, resolver, true);
      await resolverIx("unlockMarket", market, resolver, true);
      await resolverIx("lockMarket", market, resolver, true);
      await expectErr(resolve(market, NO, resolver, true), "TooEarly");
      await expectErr(resolverIx("unlockMarket", market, resolver, false), "Unauthorized"); // must pass resolver_config
      await expectErr(resolverIx("unlockMarket", market, outsider, true), "Unauthorized");
      await resolve(market, YES, resolver, true);
      await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() - 1);
      expect(await claim(creator, market)).to.eq(10n * BigInt(U) + 9_800_000n);
      expect(await claim(bob, market)).to.eq(0n);
    });

    it("resolver cannot do admin actions", async () => {
      const { market } = await createMarket(creator, YES, 10 * U, 3600);
      await review("approveMarket", market);
      const asResolver = { admin: resolver.publicKey, config: configPda };
      await expectErr(program.methods.voidMarket().accountsPartial({ ...asResolver, market }).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(program.methods.rejectMarket().accountsPartial({ ...asResolver, market }).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(program.methods.settleDispute(YES).accountsPartial({ ...asResolver, market }).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(program.methods.setPaused(true).accountsPartial(asResolver).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(setLimits(3, resolver), "Unauthorized");
      await expectErr(program.methods.setAdmin(resolver.publicKey).accountsPartial(asResolver).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(setResolver(outsider.publicKey, resolver), "Unauthorized");
      // admin still works with or without passing resolver_config
      await resolverIx("lockMarket", market, admin, true);
      await resolverIx("unlockMarket", market, admin, false);
      await review("voidMarket", market);
      expect(await claim(creator, market)).to.eq(10n * BigInt(U));
    });

    it("admin can revoke the resolver", async () => {
      const { market } = await createMarket(creator, YES, 10 * U, 3600);
      await review("approveMarket", market);
      await setResolver(PublicKey.default);
      await expectErr(resolverIx("lockMarket", market, resolver, true), "Unauthorized");
      await review("voidMarket", market);
      expect(await claim(creator, market)).to.eq(10n * BigInt(U));
    });
  });

  after(async () => {
    // Global: everything paid out plus fees never exceeds everything deposited.
    assert(totalPaid + totalFees <= totalDeposited, `paid ${totalPaid} + fees ${totalFees} > deposited ${totalDeposited}`);
    console.log(`    deposited ${totalDeposited}, paid ${totalPaid}, fees ${totalFees}`);
  });
});
