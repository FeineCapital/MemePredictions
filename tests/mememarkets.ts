// Integration tests for v3 (2 or 3 outcomes, open creation, creator fees, bonus, auto payouts).
// Run against the short-time test build:
//   ./scripts/build.sh test && anchor test --skip-build
// In that build MIN_DURATION is 2s and EMERGENCY_DELAY is 6s so deadlines and the 14 day valve can be exercised.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import { createHash } from "crypto";
import { assert, expect } from "chai";
import { Mememarkets } from "../target/types/mememarkets";

const U = 1_000_000; // 1 USDC, also 1 share
const BU = BigInt(U);
const YES = 1;
const NO = 2;
const VOID = 4;
const FEE_BPS = 100;
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

// ───────── independent copy of the curve and payout math (bigint) ─────────
const SHARE = 1_000_000n;
const num = (a: bigint, b: bigint, base: bigint, depth: bigint) => 2n * depth * base * (b - a) + b * b - a * a;
const den = (depth: bigint) => 2n * depth * SHARE;
const buyCost = (s: bigint, n: bigint, base: bigint, depth: bigint) => (num(s, s + n, base, depth) + den(depth) - 1n) / den(depth);
const sellValue = (s: bigint, n: bigint, base: bigint, depth: bigint) => num(s - n, s, base, depth) / den(depth);
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
function sharesForUsdc(s: bigint, usdc: bigint, base: bigint, depth: bigint): [bigint, bigint] {
  const k = depth * base;
  let n = isqrt((s + k) * (s + k) + den(depth) * usdc) - k - s;
  let c = buyCost(s, n, base, depth);
  while (n > 0n && c > usdc) {
    n -= 1n;
    c = buyCost(s, n, base, depth);
  }
  return [n, c];
}
type Pools = { n: number; r: bigint[]; s: bigint[]; base: bigint; depth: bigint };
const total = (p: Pools) => p.r.slice(0, p.n).reduce((a, b) => a + b, 0n);
const orphanedFor = (p: Pools) => p.r.slice(0, p.n).reduce((a, r, i) => (p.s[i] === 0n ? a + r : a), 0n);
const refundFor = (shares: bigint, side: number, p: Pools) => (p.s[side - 1] === 0n ? 0n : (shares * p.r[side - 1]) / p.s[side - 1]);
function feeFor(result: number, p: Pools): bigint {
  if (p.s[result - 1] === 0n) return orphanedFor(p);
  const t = total(p);
  const f = (t * BigInt(FEE_BPS)) / 10_000n;
  const losing = t - p.r[result - 1];
  return f < losing ? f : losing;
}
function payoutFor(shares: bigint, side: number, result: number, p: Pools): bigint {
  if (p.s[result - 1] === 0n) return refundFor(shares, side, p);
  if (side !== result) return 0n;
  return (shares * (total(p) - feeFor(result, p))) / p.s[result - 1];
}
const rulesHash = (text: string) => Array.from(createHash("sha256").update(text).digest());

describe("mememarkets v3", () => {
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
  const [resolverPda] = PublicKey.findProgramAddressSync([Buffer.from("resolver")], program.programId);
  const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_UPGRADEABLE);

  let usdc: PublicKey;
  let feeVault: PublicKey;
  const feeWallet = Keypair.generate();
  const [creator, alice, bob, carol, dave, erin, outsider] = Array.from({ length: 7 }, () => Keypair.generate());
  const everyone = [admin, creator, alice, bob, carol, dave, erin, outsider];
  const ata = new Map<string, PublicKey>();
  const usdcOf = (k: Keypair) => ata.get(k.publicKey.toBase58())!;

  // Global money ledger across every market.
  let deposited = 0n;
  let withdrawn = 0n; // sells, claims, creator fees
  let fees = 0n;

  const marketPda = (id: number | BN) =>
    PublicKey.findProgramAddressSync([Buffer.from("market"), new BN(id).toArrayLike(Buffer, "le", 8)], program.programId)[0];
  const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], program.programId)[0];
  const positionPda = (m: PublicKey, u: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], program.programId)[0];
  const bonusPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("bonus"), m.toBuffer()], program.programId)[0];

  async function chainNow() {
    return Number((await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"))!.data.readBigInt64LE(32));
  }
  async function waitUntil(ts: number) {
    while ((await chainNow()) <= ts) await new Promise((r) => setTimeout(r, 400));
  }
  const bal = async (a: PublicKey) => (await getAccount(conn, a, "confirmed")).amount;
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
  async function pools(market: PublicKey): Promise<Pools> {
    const m = await program.account.market.fetch(market);
    return {
      n: m.outcomeCount,
      r: m.reserves.map((x: BN) => BigInt(x.toString())),
      s: m.shares.map((x: BN) => BigInt(x.toString())),
      base: BigInt(m.curveBase.toString()),
      depth: BigInt(m.curveDepth.toString()),
    };
  }
  async function position(market: PublicKey, who: Keypair) {
    const p = await program.account.position.fetchNullable(positionPda(market, who.publicKey));
    return p ? { side: p.side, shares: BigInt(p.shares.toString()), cost: BigInt(p.cost.toString()), claimed: p.claimed } : null;
  }

  /** The vault equals the reserves while trading, and covers everything still owed after. */
  async function assertSolvent(market: PublicKey) {
    const m = await program.account.market.fetch(market);
    const p = await pools(market);
    const vault = await bal(vaultPda(market));
    if (m.status.open || m.status.pending || m.status.locked) {
      expect(vault).to.eq(total(p), "vault must equal reserves while trading");
      for (let i = 0; i < p.n; i++) expect(sellValue(p.s[i], p.s[i], p.base, p.depth) <= p.r[i], `outcome ${i + 1} covers a full sell out`).to.eq(true);
      return;
    }
    let owed = 0n;
    for (const u of everyone) {
      const pos = await position(market, u);
      if (!pos || pos.claimed) continue;
      owed += m.status.resolved ? payoutFor(pos.shares, pos.side, m.result, p) : refundFor(pos.shares, pos.side, p);
    }
    if (!m.feeCollected) owed += m.status.resolved ? feeFor(m.result, p) : orphanedFor(p);
    else if (!m.creatorFeePaid) owed += BigInt(m.creatorFeeOwed.toString());
    assert(vault >= owed, `vault ${vault} < owed ${owed}`);
  }

  async function createMarket(who: Keypair, side: number, amount: number, secs: number, outcomes = 2, minShares = 0n, rules = "test market") {
    const cfg = await program.account.config.fetch(configPda);
    const market = marketPda(cfg.marketCount);
    const endTs = (await chainNow()) + secs;
    const before = await bal(usdcOf(who));
    await program.methods
      .createMarket(Keypair.generate().publicKey, 0, 0, new BN(1_000_000), 0, new BN(endTs), outcomes, side, new BN(amount), new BN(minShares.toString()), rulesHash(rules))
      .accountsPartial({
        creator: who.publicKey, config: configPda, usdcMint: usdc, market, vault: vaultPda(market),
        position: positionPda(market, who.publicKey), creatorUsdc: usdcOf(who),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([who])
      .rpc();
    deposited += before - (await bal(usdcOf(who)));
    return { market, endTs };
  }

  const review = (ix: "approveMarket" | "rejectMarket" | "voidMarket", market: PublicKey, signer = admin) =>
    program.methods[ix]().accountsPartial({ admin: signer.publicKey, config: configPda, market }).signers([signer]).rpc();
  const setVerified = (market: PublicKey, v: boolean, signer = admin) =>
    program.methods.setVerified(v).accountsPartial({ admin: signer.publicKey, config: configPda, market }).signers([signer]).rpc();
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
    program.methods.settleDispute(result).accountsPartial({ admin: signer.publicKey, config: configPda, market }).signers([signer]).rpc();
  const dispute = (who: Keypair, market: PublicKey) =>
    program.methods.disputeMarket().accountsPartial({ user: who.publicKey, market, position: positionPda(market, who.publicKey) }).signers([who]).rpc();
  const emergencyVoid = (who: Keypair, market: PublicKey) =>
    program.methods.emergencyVoid().accountsPartial({ caller: who.publicKey, market }).signers([who]).rpc();

  const tradeAccounts = (who: Keypair, market: PublicKey) => ({
    user: who.publicKey, config: configPda, market, vault: vaultPda(market), position: positionPda(market, who.publicKey),
    userUsdc: usdcOf(who), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  });

  /** Buys and checks shares and cost against the independent math. Returns [shares, paid]. */
  async function buy(who: Keypair, market: PublicKey, side: number, amount: number, minShares = 0n): Promise<[bigint, bigint]> {
    const p = await pools(market);
    const [expShares, expCost] = sharesForUsdc(p.s[side - 1] ?? 0n, BigInt(amount), p.base, p.depth);
    const before = await bal(usdcOf(who));
    const posBefore = (await position(market, who))?.shares ?? 0n;
    await program.methods.buyShares(side, new BN(amount), new BN(minShares.toString())).accountsPartial(tradeAccounts(who, market)).signers([who]).rpc();
    const paid = before - (await bal(usdcOf(who)));
    const got = (await position(market, who))!.shares - posBefore;
    expect(got).to.eq(expShares, "shares bought");
    expect(paid).to.eq(expCost, "USDC paid");
    deposited += paid;
    await assertSolvent(market);
    return [got, paid];
  }

  /** Sells and checks the USDC received against the independent math. */
  async function sell(who: Keypair, market: PublicKey, shares: bigint, minOut = 0n): Promise<bigint> {
    const p = await pools(market);
    const pos = await position(market, who);
    const gross = pos ? sellValue(p.s[pos.side - 1], shares, p.base, p.depth) : 0n;
    const exp = gross - (gross * BigInt(FEE_BPS)) / 10_000n;
    const before = await bal(usdcOf(who));
    await program.methods.sellShares(new BN(shares.toString()), new BN(minOut.toString())).accountsPartial(tradeAccounts(who, market)).signers([who]).rpc();
    const got = (await bal(usdcOf(who))) - before;
    expect(got).to.eq(exp, "USDC from sell");
    withdrawn += got;
    await assertSolvent(market);
    return got;
  }

  async function claim(who: Keypair, market: PublicKey): Promise<bigint> {
    const before = await bal(usdcOf(who));
    await program.methods
      .claim()
      .accountsPartial({
        user: who.publicKey, config: configPda, market, vault: vaultPda(market),
        position: positionPda(market, who.publicKey), userUsdc: usdcOf(who), tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who])
      .rpc();
    const got = (await bal(usdcOf(who))) - before;
    withdrawn += got;
    await assertSolvent(market);
    return got;
  }

  async function claimFor(caller: Keypair, owner: Keypair, market: PublicKey, ownerUsdc?: PublicKey, positionAddr?: PublicKey): Promise<bigint> {
    const dest = ownerUsdc ?? usdcOf(owner);
    const before = await bal(dest);
    await program.methods
      .claimFor()
      .accountsPartial({
        caller: caller.publicKey, owner: owner.publicKey, config: configPda, market, vault: vaultPda(market),
        position: positionAddr ?? positionPda(market, owner.publicKey), ownerUsdc: dest, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([caller])
      .rpc();
    const got = (await bal(dest)) - before;
    withdrawn += got;
    await assertSolvent(market);
    return got;
  }

  async function addBonus(funder: Keypair, market: PublicKey, amount: number) {
    const p = await pools(market);
    const before = await bal(usdcOf(funder));
    const prevTotal = (await program.account.marketBonus.fetchNullable(bonusPda(market)))?.total.toNumber() ?? 0;
    await program.methods
      .addBonus(new BN(amount))
      .accountsPartial({
        funder: funder.publicKey, config: configPda, market, vault: vaultPda(market), bonus: bonusPda(market),
        funderUsdc: usdcOf(funder), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();
    expect(before - (await bal(usdcOf(funder)))).to.eq(BigInt(amount));
    deposited += BigInt(amount);
    const q = await pools(market);
    const part = BigInt(Math.floor(amount / p.n));
    for (let i = 0; i < p.n; i++) {
      const exp = i === p.n - 1 ? BigInt(amount) - part * BigInt(p.n - 1) : part;
      expect(q.r[i] - p.r[i]).to.eq(exp, `bonus share for outcome ${i + 1}`);
    }
    expect(q.s).to.deep.eq(p.s, "a bonus mints no shares");
    expect((await program.account.marketBonus.fetch(bonusPda(market))).total.toNumber()).to.eq(prevTotal + amount);
    await assertSolvent(market);
  }

  async function collectFees(market: PublicKey): Promise<bigint> {
    const before = await bal(feeVault);
    await program.methods
      .collectFees()
      .accountsPartial({ caller: outsider.publicKey, config: configPda, market, vault: vaultPda(market), feeVault, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([outsider])
      .rpc();
    const got = (await bal(feeVault)) - before;
    fees += got;
    return got;
  }

  async function claimCreatorFee(market: PublicKey, creatorKp: Keypair, dest?: PublicKey): Promise<bigint> {
    const to = dest ?? usdcOf(creatorKp);
    const before = await bal(to);
    await program.methods
      .claimCreatorFee()
      .accountsPartial({ caller: outsider.publicKey, creator: creatorKp.publicKey, config: configPda, market, vault: vaultPda(market), creatorUsdc: to, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([outsider])
      .rpc();
    const got = (await bal(to)) - before;
    withdrawn += got;
    return got;
  }

  const setLimits = (disputeSecs: number, signer = admin, maxBet = 500) =>
    program.methods
      .setLimits(FEE_BPS, new BN(5 * U), new BN(maxBet * U), new BN(disputeSecs))
      .accountsPartial({ admin: signer.publicKey, config: configPda })
      .signers([signer])
      .rpc();
  const setPaused = (paused: boolean, signer = admin) =>
    program.methods.setPaused(paused).accountsPartial({ admin: signer.publicKey, config: configPda }).signers([signer]).rpc();
  const setCreation = (open: boolean, shareBps: number, signer = admin) =>
    program.methods.setCreation(open, shareBps).accountsPartial({ admin: signer.publicKey, config: configPda }).signers([signer]).rpc();

  async function resolveAndWait(market: PublicKey, result: number) {
    await resolve(market, result);
    await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() - 1);
  }

  async function claimAllAndCheck(market: PublicKey, holders: Keypair[]) {
    const m = await program.account.market.fetch(market);
    const p = await pools(market);
    for (const h of holders) {
      const pos = (await position(market, h))!;
      const exp = m.status.resolved ? payoutFor(pos.shares, pos.side, m.result, p) : refundFor(pos.shares, pos.side, p);
      expect(await claim(h, market)).to.eq(exp, "claim amount");
    }
  }

  // ───────── setup ─────────

  before(async () => {
    for (const k of [feeWallet, ...everyone.filter((k) => k !== admin)]) {
      await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
    }
    usdc = await createMint(conn, admin, admin.publicKey, null, 6);
    feeVault = await createAssociatedTokenAccount(conn, admin, usdc, feeWallet.publicKey);
    for (const k of everyone) {
      const a = await createAssociatedTokenAccount(conn, admin, usdc, k.publicKey);
      ata.set(k.publicKey.toBase58(), a);
      await mintTo(conn, admin, usdc, a, admin, 10_000 * U);
    }
  });

  const initIx = (signer: Keypair, disputeSecs = 3, mint?: PublicKey) =>
    program.methods
      .initialize(FEE_BPS, new BN(5 * U), new BN(500 * U), new BN(disputeSecs))
      .accountsPartial({
        admin: signer.publicKey, config: configPda, usdcMint: mint ?? usdc, feeVault,
        program: program.programId, programData, systemProgram: SystemProgram.programId,
      })
      .signers([signer]);

  // ───────── setup and admin ─────────

  it("initialize: only the upgrade authority, sane values, 6 decimal mint, once; creation starts closed", async () => {
    await expectErr(initIx(outsider).rpc(), "Unauthorized");
    await expectErr(initIx(admin, 8 * 24 * 3600).rpc(), "BadConfig");
    const nine = await createMint(conn, admin, admin.publicKey, null, 9);
    await expectErr(initIx(admin, 3, nine).rpc(), "BadConfig");
    await initIx(admin).rpc();
    const c = await program.account.config.fetch(configPda);
    assert(c.admin.equals(admin.publicKey) && c.feeVault.equals(feeVault) && c.usdcMint.equals(usdc));
    expect([c.feeBps, c.minBet.toNumber(), c.maxBet.toNumber(), c.disputeSecs.toNumber(), c.marketCount.toNumber(), c.paused]).to.deep.eq([
      FEE_BPS, 5 * U, 500 * U, 3, 0, false,
    ]);
    expect([c.curveBase.toNumber(), c.curveDepth.toNumber(), c.openCreation, c.creatorFeeShareBps]).to.deep.eq([100_000, 10_000, false, 0]);
    await expectErr(initIx(admin).rpc(), "already in use");
  });

  it("admin controls: only admin, bounds enforced, admin hand over and back", async () => {
    await expectErr(setPaused(true, outsider), "Unauthorized");
    await expectErr(setLimits(3, outsider), "Unauthorized");
    await expectErr(setLimits(8 * 24 * 3600), "BadConfig");
    await expectErr(setCreation(true, 0, outsider), "Unauthorized");
    await expectErr(setCreation(true, 10_001), "BadConfig");
    const setCurve = (b: number, d: number, s = admin) =>
      program.methods.setCurve(new BN(b), new BN(d)).accountsPartial({ admin: s.publicKey, config: configPda }).signers([s]).rpc();
    await expectErr(setCurve(100_000, 10_000, outsider), "Unauthorized");
    await expectErr(setCurve(999, 10_000), "BadConfig");
    await expectErr(setCurve(100_000, 99), "BadConfig");
    await setCurve(200_000, 20_000);
    await setCurve(100_000, 10_000);
    await expectErr(
      program.methods.setAdmin(PublicKey.default).accountsPartial({ admin: admin.publicKey, config: configPda }).signers([admin]).rpc(),
      "BadConfig"
    );
    await program.methods.setAdmin(carol.publicKey).accountsPartial({ admin: admin.publicKey, config: configPda }).signers([admin]).rpc();
    await expectErr(setPaused(false, admin), "Unauthorized");
    await program.methods.setAdmin(admin.publicKey).accountsPartial({ admin: carol.publicKey, config: configPda }).signers([carol]).rpc();
  });

  it("create_market: enforces outcomes, side, min, max, deadline, slippage; stores the rules hash", async () => {
    await expectErr(createMarket(creator, YES, 5 * U - 1, 10), "BadAmount");
    await expectErr(createMarket(creator, YES, 500 * U + 1, 10), "BadAmount");
    await expectErr(createMarket(creator, 3, 10 * U, 10), "BadSide"); // outcome 3 in a 2 outcome market
    await expectErr(createMarket(creator, 4, 10 * U, 10, 3), "BadSide");
    await expectErr(createMarket(creator, YES, 10 * U, 10, 4), "BadParams");
    await expectErr(createMarket(creator, YES, 10 * U, 10, 1), "BadParams");
    await expectErr(createMarket(creator, YES, 10 * U, 1), "BadDeadline");
    await expectErr(createMarket(creator, YES, 10 * U, 10, 2, 10n ** 15n), "Slippage");
    const { market } = await createMarket(creator, YES, 10 * U, 60, 2, 0n, "Will $X hit $1M by Friday?");
    const m = await program.account.market.fetch(market);
    expect(Buffer.from(m.rulesHash).equals(Buffer.from(rulesHash("Will $X hit $1M by Friday?")))).to.eq(true);
    assert(m.status.pending, "user markets wait for approval while creation is closed");
    expect([m.verified, m.creatorFeeBps]).to.deep.eq([false, 0]);
    await review("rejectMarket", market);
    await claimAllAndCheck(market, [creator]);
  });

  describe("staged rollout: admin markets, open creation, verified badge", () => {
    it("admin created markets open instantly and are Verified with no creator share", async () => {
      await setCreation(false, 5_000);
      const { market } = await createMarket(admin, YES, 10 * U, 60);
      const m = await program.account.market.fetch(market);
      assert(m.status.open);
      expect([m.verified, m.creatorFeeBps]).to.deep.eq([true, 0]);
      await review("voidMarket", market);
      await claimAllAndCheck(market, [admin]);
    });

    it("open creation: user markets go live instantly, unverified, with the creator share; badge is admin only", async () => {
      await setCreation(true, 2_500);
      const { market } = await createMarket(creator, NO, 10 * U, 60);
      const m = await program.account.market.fetch(market);
      assert(m.status.open, "no approval needed");
      expect([m.verified, m.creatorFeeBps]).to.deep.eq([false, 2_500]);
      await buy(alice, market, YES, 10 * U);
      await expectErr(setVerified(market, true, outsider), "Unauthorized");
      await setVerified(market, true);
      expect((await program.account.market.fetch(market)).verified).to.eq(true);
      await setVerified(market, false);
      await setCreation(false, 0);
      await review("voidMarket", market);
      await claimAllAndCheck(market, [creator, alice]);
    });
  });

  // ───────── trading, two outcomes ─────────

  describe("two outcomes: buying, selling, Yes resolution", () => {
    let market: PublicKey;
    let endTs: number;

    it("create with a seed buy, approve, prices rise as people buy", async () => {
      await setLimits(5);
      ({ market, endTs } = await createMarket(creator, YES, 100 * U, 30));
      expect((await program.account.market.fetch(market)).disputeSecs.toNumber()).to.eq(5);
      await expectErr(buy(alice, market, YES, 10 * U), "BadStatus");
      await expectErr(review("approveMarket", market, outsider), "Unauthorized");
      await review("approveMarket", market);
      await buy(alice, market, YES, 50 * U);
      await buy(bob, market, NO, 80 * U);
      await buy(carol, market, NO, 40 * U);
      const bobPos = (await position(market, bob))!;
      const carolPos = (await position(market, carol))!;
      assert(carolPos.shares * 80n < bobPos.shares * 40n, "later buyer pays a higher price");
    });

    it("limits: other side, outcome 3 missing, max per wallet, min buy, slippage", async () => {
      await expectErr(buy(alice, market, NO, 10 * U), "OtherSide");
      await expectErr(buy(dave, market, 3, 10 * U), "BadSide");
      await expectErr(buy(bob, market, NO, 421 * U), "OverMax");
      await expectErr(buy(carol, market, NO, 5 * U - 1), "BadAmount");
      await expectErr(buy(carol, market, NO, 10 * U, 10n ** 15n), "Slippage");
    });

    it("cash out: early buyer sells at a profit; partial sell; guards; empty position may switch", async () => {
      const [daveShares, davePaid] = await buy(dave, market, NO, 20 * U);
      await buy(erin, market, NO, 300 * U);
      const got = await sell(dave, market, daveShares);
      assert(got > davePaid, `dave paid ${davePaid} and got ${got}`);
      const before = (await position(market, alice))!;
      const half = before.shares / 2n;
      await sell(alice, market, half);
      const after = (await position(market, alice))!;
      expect(after.cost).to.eq(before.cost - (before.cost * half) / before.shares);
      await expectErr(sell(alice, market, after.shares + 1n), "NotEnoughShares");
      await expectErr(sell(alice, market, 1000n, 10n ** 12n), "Slippage");
      await buy(dave, market, YES, 10 * U);
      expect((await position(market, dave))!.side).to.eq(YES);
    });

    it("no trading after the deadline, no early No or Void or unlocked Yes", async () => {
      await expectErr(resolve(market, NO), "TooEarly");
      await expectErr(resolve(market, VOID), "TooEarly");
      await expectErr(resolve(market, YES), "TooEarly");
      await expectErr(resolve(market, 3), "BadParams");
      await waitUntil(endTs);
      await expectErr(buy(carol, market, NO, 10 * U), "BettingClosed");
      await expectErr(sell(carol, market, 1000n), "BettingClosed");
      await expectErr(resolve(market, YES, outsider), "Unauthorized");
    });

    it("resolve Yes: no claims in the window, exact payouts after, no double claim, fee once", async () => {
      await resolve(market, YES);
      await expectErr(claim(creator, market), "NotClaimable");
      await expectErr(collectFees(market), "NotClaimable");
      await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() - 1);
      await expectErr(dispute(bob, market), "DisputeClosed");
      const p = await pools(market);
      await claimAllAndCheck(market, [creator, alice, bob, carol, dave, erin]);
      await expectErr(claim(bob, market), "AlreadyClaimed");
      expect(await collectFees(market)).to.eq(feeFor(YES, p));
      await expectErr(collectFees(market), "AlreadyClaimed");
      assert((await bal(vaultPda(market))) < 10n);
    });
  });

  // ───────── three outcomes ─────────

  describe("three outcomes", () => {
    it("winners of the chosen outcome take both other pools; early result from Locked", async () => {
      await setLimits(3);
      const { market, endTs } = await createMarket(creator, 1, 30 * U, 3600, 3);
      await review("approveMarket", market);
      await buy(alice, market, 2, 50 * U);
      await buy(bob, market, 3, 20 * U);
      await buy(carol, market, 3, 10 * U);
      await expectErr(resolve(market, 3), "TooEarly"); // must lock first
      await resolverIx("lockMarket", market);
      await expectErr(resolve(market, VOID), "TooEarly"); // void only after the deadline
      await resolve(market, 3); // any outcome can resolve early from Locked in a 3 outcome market
      const m = await program.account.market.fetch(market);
      assert(m.resolvedTs.toNumber() < endTs);
      await waitUntil(m.disputeEnds.toNumber() - 1);
      const p = await pools(market);
      const t = total(p);
      const bobGot = await claim(bob, market);
      const carolGot = await claim(carol, market);
      expect(bobGot).to.eq(payoutFor((await position(market, bob))!.shares, 3, 3, p));
      assert(bobGot + carolGot <= t - feeFor(3, p) && bobGot + carolGot >= t - feeFor(3, p) - 2n, "outcome 3 holders take the whole pot");
      expect(await claim(creator, market)).to.eq(0n);
      expect(await claim(alice, market)).to.eq(0n);
      expect(await collectFees(market)).to.eq(feeFor(3, p));
    });

    it("nobody on the winning outcome: everyone gets their own outcome's money back, leftovers swept", async () => {
      const { market, endTs } = await createMarket(creator, 1, 20 * U, 5, 3);
      await review("approveMarket", market);
      await buy(alice, market, 3, 15 * U);
      await addBonus(outsider, market, 9 * U); // 3 USDC to each outcome, including the empty outcome 2
      await waitUntil(endTs);
      await resolveAndWait(market, 2);
      const p = await pools(market);
      await claimAllAndCheck(market, [creator, alice]);
      expect(await collectFees(market)).to.eq(p.r[1]); // outcome 2's bonus share
      expect(await bal(vaultPda(market))).to.eq(0n);
    });

    it("void refunds each outcome's holders; settle_dispute can pick any outcome", async () => {
      const a = await createMarket(creator, 1, 10 * U, 60, 3);
      await review("approveMarket", a.market);
      await buy(alice, a.market, 2, 10 * U);
      await buy(bob, a.market, 3, 10 * U);
      await review("voidMarket", a.market);
      await claimAllAndCheck(a.market, [creator, alice, bob]);

      await setLimits(20);
      const b = await createMarket(creator, 1, 10 * U, 5, 3);
      await setLimits(3);
      await review("approveMarket", b.market);
      await buy(alice, b.market, 2, 10 * U);
      await buy(bob, b.market, 3, 10 * U);
      await waitUntil(b.endTs);
      await resolve(b.market, 1);
      await dispute(bob, b.market);
      await expectErr(settle(b.market, 5), "BadParams");
      await settle(b.market, 3);
      await claimAllAndCheck(b.market, [creator, alice, bob]);
      await collectFees(b.market);
    });
  });

  // ───────── creator fees ─────────

  describe("creator fee share", () => {
    it("collect_fees splits the fee; the creator share pays out once, only to the creator", async () => {
      await setCreation(true, 4_000); // 40 percent of the fee to creators
      const { market, endTs } = await createMarket(creator, YES, 40 * U, 5);
      assert((await program.account.market.fetch(market)).status.open);
      await buy(alice, market, NO, 60 * U);
      await setCreation(false, 0); // the market keeps the share it was created with
      await expectErr(claimCreatorFee(market, creator), "NotClaimable"); // before collect_fees
      await waitUntil(endTs);
      await resolveAndWait(market, NO);
      const p = await pools(market);
      const fee = feeFor(NO, p);
      const creatorPart = (fee * 4_000n) / 10_000n;
      await claimAllAndCheck(market, [creator, alice]);
      expect(await collectFees(market)).to.eq(fee - creatorPart);
      expect((await program.account.market.fetch(market)).creatorFeeOwed.toNumber()).to.eq(Number(creatorPart));
      await assertSolvent(market);
      await expectErr(claimCreatorFee(market, creator, usdcOf(outsider)), "ConstraintTokenOwner");
      await expectErr(claimCreatorFee(market, outsider, usdcOf(outsider)), "Unauthorized");
      expect(await claimCreatorFee(market, creator)).to.eq(creatorPart);
      await expectErr(claimCreatorFee(market, creator), "AlreadyClaimed");
      assert((await bal(vaultPda(market))) < 10n);
    });
  });

  // ───────── lock, disputes, refunds ─────────

  describe("lock, unlock, early Yes", () => {
    it("lock stops trading, unlock reopens, Yes from Locked before the deadline", async () => {
      const { market, endTs } = await createMarket(creator, YES, 20 * U, 3600);
      await review("approveMarket", market);
      const [bobShares] = await buy(bob, market, NO, 30 * U);
      await expectErr(resolverIx("lockMarket", market, outsider), "Unauthorized");
      await resolverIx("lockMarket", market);
      await expectErr(buy(alice, market, YES, 10 * U), "BadStatus");
      await expectErr(sell(bob, market, bobShares), "BadStatus");
      await resolverIx("unlockMarket", market);
      await sell(bob, market, bobShares / 3n);
      await resolverIx("lockMarket", market);
      await expectErr(resolve(market, NO), "TooEarly");
      await resolve(market, YES);
      const m = await program.account.market.fetch(market);
      assert(m.resolvedTs.toNumber() < endTs);
      await waitUntil(m.disputeEnds.toNumber() - 1);
      await claimAllAndCheck(market, [creator, bob]);
      await collectFees(market);
    });

    it("unlock fails after the deadline; emergency void of a stuck lock", async () => {
      const a = await createMarket(creator, YES, 10 * U, 4);
      await review("approveMarket", a.market);
      await buy(bob, a.market, NO, 10 * U);
      await resolverIx("lockMarket", a.market);
      await waitUntil(a.endTs);
      await expectErr(resolverIx("unlockMarket", a.market), "DeadlinePassed");
      await resolveAndWait(a.market, NO);
      await claimAllAndCheck(a.market, [creator, bob]);

      const b = await createMarket(creator, YES, 10 * U, 3600);
      await review("approveMarket", b.market);
      await buy(bob, b.market, NO, 10 * U);
      await resolverIx("lockMarket", b.market);
      const lockedAt = (await program.account.market.fetch(b.market)).resolvedTs.toNumber();
      await expectErr(emergencyVoid(outsider, b.market), "TooEarly");
      await waitUntil(lockedAt + 6);
      await emergencyVoid(outsider, b.market);
      await claimAllAndCheck(b.market, [creator, bob]);
    });
  });

  describe("disputes and refunds", () => {
    it("bettor disputes, claims freeze, admin settles to No", async () => {
      await setLimits(30);
      const { market, endTs } = await createMarket(creator, YES, 60 * U, 6);
      await setLimits(3);
      await review("approveMarket", market);
      await buy(bob, market, NO, 40 * U);
      await waitUntil(endTs);
      await resolve(market, YES);
      await expectErr(dispute(outsider, market), "AccountNotInitialized");
      await dispute(bob, market);
      await expectErr(claim(creator, market), "NotClaimable");
      await expectErr(settle(market, NO, outsider), "Unauthorized");
      await settle(market, NO);
      await claimAllAndCheck(market, [creator, bob]);
      expect(await collectFees(market)).to.eq(feeFor(NO, await pools(market)));
    });

    it("emergency void of an unsettled dispute and of an unresolved open market", async () => {
      const a = await createMarket(creator, YES, 30 * U, 4);
      await review("approveMarket", a.market);
      await buy(bob, a.market, NO, 20 * U);
      await waitUntil(a.endTs);
      await resolve(a.market, YES);
      await dispute(bob, a.market);
      await waitUntil((await program.account.market.fetch(a.market)).disputeEnds.toNumber() + 6);
      await emergencyVoid(outsider, a.market);
      await claimAllAndCheck(a.market, [creator, bob]);

      const b = await createMarket(creator, YES, 30 * U, 4);
      await review("approveMarket", b.market);
      await buy(bob, b.market, NO, 20 * U);
      await waitUntil(b.endTs);
      await expectErr(emergencyVoid(outsider, b.market), "TooEarly");
      await waitUntil(b.endTs + 6);
      await emergencyVoid(outsider, b.market);
      await claimAllAndCheck(b.market, [creator, bob]);
    });

    it("one sided markets, resolve Void, reject, cancel_pending, orphan sweeps", async () => {
      const a = await createMarket(creator, YES, 20 * U, 4);
      await review("approveMarket", a.market);
      await buy(alice, a.market, YES, 30 * U);
      await waitUntil(a.endTs);
      await resolveAndWait(a.market, NO); // nobody on No: Yes holders get their own money back
      await claimAllAndCheck(a.market, [creator, alice]);
      expect(await collectFees(a.market)).to.eq(0n);

      const b = await createMarket(creator, NO, 10 * U, 4);
      await review("approveMarket", b.market);
      await buy(alice, b.market, YES, 10 * U);
      await waitUntil(b.endTs);
      await resolve(b.market, VOID);
      await claimAllAndCheck(b.market, [creator, alice]);

      const c = await createMarket(creator, YES, 40 * U, 60);
      await expectErr(review("rejectMarket", c.market, outsider), "Unauthorized");
      await review("rejectMarket", c.market);
      await claimAllAndCheck(c.market, [creator]);

      const d = await createMarket(creator, NO, 12 * U, 60);
      await expectErr(
        program.methods.cancelPending().accountsPartial({ creator: outsider.publicKey, market: d.market }).signers([outsider]).rpc(),
        "Unauthorized"
      );
      await program.methods.cancelPending().accountsPartial({ creator: creator.publicKey, market: d.market }).signers([creator]).rpc();
      await claimAllAndCheck(d.market, [creator]);

      const e = await createMarket(creator, YES, 20 * U, 60);
      await review("approveMarket", e.market);
      const [bobShares] = await buy(bob, e.market, NO, 10 * U);
      await sell(bob, e.market, bobShares);
      const pe = await pools(e.market);
      await review("voidMarket", e.market);
      expect(await claim(creator, e.market)).to.eq(pe.r[0]);
      expect(await collectFees(e.market)).to.eq(pe.r[1]); // No's retained sell fee
      expect(await bal(vaultPda(e.market))).to.eq(0n);
    });
  });

  // ───────── automatic payouts and bonus ─────────

  describe("automatic payouts (claim_for)", () => {
    it("anyone can pay holders into their own wallets, exact, once; cannot redirect", async () => {
      await setLimits(4);
      const { market, endTs } = await createMarket(creator, YES, 30 * U, 6);
      await review("approveMarket", market);
      await buy(alice, market, YES, 20 * U);
      await buy(bob, market, NO, 40 * U);
      await expectErr(claimFor(outsider, alice, market), "NotClaimable");
      await waitUntil(endTs);
      await resolve(market, YES);
      await expectErr(claimFor(outsider, alice, market), "NotClaimable");
      await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() - 1);
      await expectErr(claimFor(outsider, alice, market, usdcOf(outsider)), "ConstraintTokenOwner");
      await expectErr(claimFor(outsider, outsider, market, usdcOf(outsider), positionPda(market, alice.publicKey)), "ConstraintSeeds");
      const p = await pools(market);
      const callerBefore = await bal(usdcOf(outsider));
      for (const h of [creator, alice, bob]) {
        const pos = (await position(market, h))!;
        expect(await claimFor(outsider, h, market)).to.eq(payoutFor(pos.shares, pos.side, YES, p));
      }
      expect(await bal(usdcOf(outsider))).to.eq(callerBefore);
      await expectErr(claimFor(outsider, alice, market), "AlreadyClaimed");
      await expectErr(claim(alice, market), "AlreadyClaimed");
      await collectFees(market);
    });
  });

  describe("bonus pot", () => {
    it("bonus goes to the winners, the funder gets nothing; not after lock or resolution", async () => {
      const { market, endTs } = await createMarket(creator, YES, 20 * U, 8);
      await addBonus(outsider, market, 15 * U); // while Pending
      await review("approveMarket", market);
      await addBonus(outsider, market, 15 * U); // while Open
      await expectErr(addBonus(outsider, market, 0), "BadAmount");
      expect(await position(market, outsider)).to.eq(null);
      const [aliceShares, alicePaid] = await buy(alice, market, NO, 10 * U);
      await resolverIx("lockMarket", market);
      await expectErr(addBonus(outsider, market, 5 * U), "BadStatus");
      await resolverIx("unlockMarket", market);
      await waitUntil(endTs);
      await resolveAndWait(market, NO);
      await expectErr(addBonus(outsider, market, 5 * U), "BadStatus");
      const p = await pools(market);
      const got = await claim(alice, market);
      expect(got).to.eq(payoutFor(aliceShares, NO, NO, p));
      assert(got > alicePaid + 20n * BU + 29n * BU, `alice got ${got}`);
      expect(await claim(creator, market)).to.eq(0n);
      await expectErr(claim(outsider, market), "AccountNotInitialized");
      await collectFees(market);
    });
  });

  // ───────── pause, resolver, lopsided ─────────

  describe("pause", () => {
    it("blocks buying, selling and new markets but not claims", async () => {
      const { market } = await createMarket(creator, YES, 10 * U, 60);
      await review("approveMarket", market);
      const [s] = await buy(alice, market, NO, 10 * U);
      await setPaused(true);
      await expectErr(buy(bob, market, NO, 10 * U), "Paused");
      await expectErr(sell(alice, market, s), "Paused");
      await expectErr(createMarket(creator, YES, 10 * U, 60), "Paused");
      await review("voidMarket", market);
      await claimAllAndCheck(market, [alice, creator]);
      await setPaused(false);
    });
  });

  describe("resolver role", () => {
    const resolver = Keypair.generate();
    const setResolver = (key: PublicKey, signer = admin) =>
      program.methods
        .setResolver(key)
        .accountsPartial({ admin: signer.publicKey, config: configPda, resolverConfig: resolverPda, systemProgram: SystemProgram.programId })
        .signers([signer])
        .rpc();

    before(async () => {
      await conn.confirmTransaction(await conn.requestAirdrop(resolver.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
    });

    it("can lock, unlock and resolve, cannot do admin actions, can be revoked", async () => {
      await expectErr(setResolver(resolver.publicKey, outsider), "Unauthorized");
      await setResolver(resolver.publicKey);
      const { market } = await createMarket(creator, YES, 10 * U, 3600);
      await review("approveMarket", market);
      await buy(bob, market, NO, 10 * U);
      await resolverIx("lockMarket", market, resolver, true);
      await resolverIx("unlockMarket", market, resolver, true);
      await resolverIx("lockMarket", market, resolver, true);
      await expectErr(resolverIx("unlockMarket", market, resolver, false), "Unauthorized");
      const asR = { admin: resolver.publicKey, config: configPda };
      await expectErr(program.methods.voidMarket().accountsPartial({ ...asR, market }).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(program.methods.setVerified(true).accountsPartial({ ...asR, market }).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(program.methods.settleDispute(YES).accountsPartial({ ...asR, market }).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(program.methods.setPaused(true).accountsPartial(asR).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(program.methods.setCreation(true, 0).accountsPartial(asR).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(setLimits(3, resolver), "Unauthorized");
      await expectErr(program.methods.setAdmin(resolver.publicKey).accountsPartial(asR).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(setResolver(outsider.publicKey, resolver), "Unauthorized");
      await expectErr(resolve(market, NO, resolver, true), "TooEarly");
      await resolve(market, YES, resolver, true);
      await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() - 1);
      await claimAllAndCheck(market, [creator, bob]);

      const second = await createMarket(creator, YES, 10 * U, 3600);
      await review("approveMarket", second.market);
      await setResolver(PublicKey.default);
      await expectErr(resolverIx("lockMarket", second.market, resolver, true), "Unauthorized");
      await review("voidMarket", second.market);
      await claimAllAndCheck(second.market, [creator]);
    });
  });

  describe("lopsided pot", () => {
    it("fee is capped at the losing money", async () => {
      const { market, endTs } = await createMarket(creator, YES, 500 * U, 8);
      await review("approveMarket", market);
      await buy(alice, market, YES, 500 * U);
      await buy(bob, market, YES, 490 * U);
      await buy(carol, market, NO, 5 * U);
      await waitUntil(endTs);
      await resolveAndWait(market, YES);
      const p = await pools(market);
      const fee = feeFor(YES, p);
      expect(fee).to.eq(p.r[1]);
      let paid = 0n;
      for (const h of [creator, alice, bob]) paid += await claim(h, market);
      expect(await claim(carol, market)).to.eq(0n);
      assert(paid >= p.r[0] - 3n);
      expect(await collectFees(market)).to.eq(fee);
    });
  });

  after(async () => {
    console.log(`    deposited ${deposited}, withdrawn ${withdrawn}, fees ${fees}`);
    assert(withdrawn + fees <= deposited, "never pays out more than was put in");
  });
});
