// Integration tests for the share trading version. Run against the short-time test build:
//   ./scripts/build.sh test && anchor test --skip-build
// In that build MIN_DURATION is 2s and EMERGENCY_DELAY is 6s so deadlines and the 14 day valve can be exercised.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import { assert, expect } from "chai";
import { Mememarkets } from "../target/types/mememarkets";

const U = 1_000_000; // 1 USDC, also 1 share
const BU = BigInt(U);
const YES = 1;
const NO = 2;
const VOID = 3;
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
  const b = isqrt((s + k) * (s + k) + den(depth) * usdc) - k;
  let n = b - s;
  let c = buyCost(s, n, base, depth);
  while (n > 0n && c > usdc) {
    n -= 1n;
    c = buyCost(s, n, base, depth);
  }
  return [n, c];
}
type Pools = { yr: bigint; nr: bigint; ys: bigint; ns: bigint };
const side = (p: Pools, s: number) => (s === YES ? { r: p.yr, sh: p.ys } : { r: p.nr, sh: p.ns });
function feeFor(result: number, p: Pools): bigint {
  const win = side(p, result);
  const lose = side(p, result === YES ? NO : YES);
  if (win.sh === 0n) return lose.sh === 0n ? p.yr + p.nr : 0n;
  const f = ((p.yr + p.nr) * BigInt(FEE_BPS)) / 10_000n;
  return f < lose.r ? f : lose.r;
}
function payoutFor(shares: bigint, s: number, result: number, p: Pools): bigint {
  const total = p.yr + p.nr;
  const win = side(p, result);
  if (win.sh === 0n) {
    const own = side(p, s);
    return own.sh === 0n ? 0n : (shares * total) / own.sh;
  }
  if (s !== result) return 0n;
  return (shares * (total - feeFor(result, p))) / win.sh;
}
const refundFor = (shares: bigint, s: number, p: Pools) => {
  const own = side(p, s);
  return own.sh === 0n ? 0n : (shares * own.r) / own.sh;
};
const orphanedFor = (p: Pools) => (p.ys === 0n ? p.yr : 0n) + (p.ns === 0n ? p.nr : 0n);

describe("mememarkets (share trading)", () => {
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
  const everyone = [creator, alice, bob, carol, dave, erin, outsider];
  const ata = new Map<string, PublicKey>();
  const usdcOf = (k: Keypair) => ata.get(k.publicKey.toBase58())!;

  // Global money ledger across every market.
  let deposited = 0n;
  let withdrawn = 0n; // sells + claims
  let fees = 0n;

  const marketPda = (id: number | BN) =>
    PublicKey.findProgramAddressSync([Buffer.from("market"), new BN(id).toArrayLike(Buffer, "le", 8)], program.programId)[0];
  const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], program.programId)[0];
  const positionPda = (m: PublicKey, u: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], program.programId)[0];

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
  async function pools(market: PublicKey): Promise<Pools & { base: bigint; depth: bigint }> {
    const m = await program.account.market.fetch(market);
    return {
      yr: BigInt(m.yesReserve.toString()),
      nr: BigInt(m.noReserve.toString()),
      ys: BigInt(m.yesShares.toString()),
      ns: BigInt(m.noShares.toString()),
      base: BigInt(m.curveBase.toString()),
      depth: BigInt(m.curveDepth.toString()),
    };
  }
  async function position(market: PublicKey, who: Keypair) {
    const p = await program.account.position.fetchNullable(positionPda(market, who.publicKey));
    return p ? { side: p.side, shares: BigInt(p.shares.toString()), cost: BigInt(p.cost.toString()), claimed: p.claimed } : null;
  }

  /** The vault always equals the two reserves while trading, and always covers what is still owed after. */
  async function assertSolvent(market: PublicKey) {
    const m = await program.account.market.fetch(market);
    const p = await pools(market);
    const vault = await bal(vaultPda(market));
    if (m.status.open || m.status.pending || m.status.locked) {
      expect(vault).to.eq(p.yr + p.nr, "vault must equal reserves while trading");
      expect(sellValue(p.ys, p.ys, p.base, p.depth) <= p.yr, "yes reserve covers a full sell out").to.eq(true);
      expect(sellValue(p.ns, p.ns, p.base, p.depth) <= p.nr, "no reserve covers a full sell out").to.eq(true);
      return;
    }
    let owed = 0n;
    for (const u of everyone) {
      const pos = await position(market, u);
      if (!pos || pos.claimed) continue;
      owed += m.status.resolved ? payoutFor(pos.shares, pos.side, m.result, p) : refundFor(pos.shares, pos.side, p);
    }
    if (!m.feeCollected) owed += m.status.resolved ? feeFor(m.result, p) : orphanedFor(p);
    assert(vault >= owed, `vault ${vault} < owed ${owed}`);
  }

  async function createMarket(who: Keypair, s: number, amount: number, secs: number, minShares = 0n) {
    const cfg = await program.account.config.fetch(configPda);
    const market = marketPda(cfg.marketCount);
    const endTs = (await chainNow()) + secs;
    const before = await bal(usdcOf(who));
    await program.methods
      .createMarket(Keypair.generate().publicKey, 0, 0, new BN(1_000_000), 0, new BN(endTs), s, new BN(amount), new BN(minShares.toString()))
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
  async function buy(who: Keypair, market: PublicKey, s: number, amount: number, minShares = 0n): Promise<[bigint, bigint]> {
    const p = await pools(market);
    const [expShares, expCost] = sharesForUsdc(s === YES ? p.ys : p.ns, BigInt(amount), p.base, p.depth);
    const before = await bal(usdcOf(who));
    const posBefore = (await position(market, who))?.shares ?? 0n;
    await program.methods.buyShares(s, new BN(amount), new BN(minShares.toString())).accountsPartial(tradeAccounts(who, market)).signers([who]).rpc();
    const paid = before - (await bal(usdcOf(who)));
    const got = (await position(market, who))!.shares - posBefore;
    expect(got).to.eq(expShares, "shares bought");
    expect(paid).to.eq(expCost, "USDC paid");
    deposited += paid;
    await assertSolvent(market);
    return [got, paid];
  }

  /** Sells and checks the USDC received against the independent math. Returns USDC received. */
  async function sell(who: Keypair, market: PublicKey, shares: bigint, minOut = 0n): Promise<bigint> {
    const p = await pools(market);
    const pos = await position(market, who);
    const gross = pos ? sellValue(pos.side === YES ? p.ys : p.ns, shares, p.base, p.depth) : 0n;
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

  const setLimits = (disputeSecs: number, signer = admin, maxBet = 500) =>
    program.methods
      .setLimits(FEE_BPS, new BN(5 * U), new BN(maxBet * U), new BN(disputeSecs))
      .accountsPartial({ admin: signer.publicKey, config: configPda })
      .signers([signer])
      .rpc();
  const setPaused = (paused: boolean, signer = admin) =>
    program.methods.setPaused(paused).accountsPartial({ admin: signer.publicKey, config: configPda }).signers([signer]).rpc();

  /** Resolves and waits out the dispute window. */
  async function resolveAndWait(market: PublicKey, result: number) {
    await resolve(market, result);
    await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() - 1);
  }

  /** Claims for every holder and checks each payout against the independent math. */
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
    for (const k of [feeWallet, ...everyone]) {
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

  // ───────── setup and admin ─────────

  const initIx = (signer: Keypair, disputeSecs = 3, mint?: PublicKey) =>
    program.methods
      .initialize(FEE_BPS, new BN(5 * U), new BN(500 * U), new BN(disputeSecs))
      .accountsPartial({
        admin: signer.publicKey, config: configPda, usdcMint: mint ?? usdc, feeVault,
        program: program.programId, programData, systemProgram: SystemProgram.programId,
      })
      .signers([signer]);

  it("initialize: only the upgrade authority, sane values, 6 decimal mint, once", async () => {
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
    expect([c.curveBase.toNumber(), c.curveDepth.toNumber()]).to.deep.eq([100_000, 10_000]);
    await expectErr(initIx(admin).rpc(), "already in use");
  });

  it("admin controls: only admin, bounds enforced, admin hand over and back", async () => {
    await expectErr(setPaused(true, outsider), "Unauthorized");
    await expectErr(setLimits(3, outsider), "Unauthorized");
    await expectErr(setLimits(8 * 24 * 3600), "BadConfig");
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

  it("create_market: enforces min, max, side, deadline, slippage", async () => {
    await expectErr(createMarket(creator, YES, 5 * U - 1, 10), "BadAmount");
    await expectErr(createMarket(creator, YES, 500 * U + 1, 10), "BadAmount");
    await expectErr(createMarket(creator, 3, 10 * U, 10), "BadSide");
    await expectErr(createMarket(creator, YES, 10 * U, 1), "BadDeadline");
    await expectErr(createMarket(creator, YES, 10 * U, 10, 10n ** 15n), "Slippage");
  });

  // ───────── trading ─────────

  describe("buying, selling and a Yes resolution", () => {
    let market: PublicKey;
    let endTs: number;

    it("create with a seed buy, approve, prices rise as people buy", async () => {
      await setLimits(5);
      ({ market, endTs } = await createMarket(creator, YES, 100 * U, 30));
      const m = await program.account.market.fetch(market);
      assert(m.status.pending);
      expect(m.disputeSecs.toNumber()).to.eq(5);
      const [seedShares] = sharesForUsdc(0n, 100n * BU, 100_000n, 10_000n);
      expect((await position(market, creator))!.shares).to.eq(seedShares);
      await expectErr(buy(alice, market, YES, 10 * U), "BadStatus");
      await expectErr(review("approveMarket", market, outsider), "Unauthorized");
      await review("approveMarket", market);

      const yesSupplyBefore = (await pools(market)).ys;
      await buy(alice, market, YES, 50 * U);
      await buy(bob, market, NO, 80 * U);
      await buy(carol, market, NO, 40 * U);
      assert((await pools(market)).ys > yesSupplyBefore);
      const bobPos = (await position(market, bob))!;
      const carolPos = (await position(market, carol))!;
      assert(carolPos.shares * 80n < bobPos.shares * 40n, "later buyer pays a higher price");
    });

    it("limits: other side, max per wallet, min buy, slippage", async () => {
      await expectErr(buy(alice, market, NO, 10 * U), "OtherSide");
      await expectErr(buy(bob, market, NO, 421 * U), "OverMax"); // 80 + 421 > 500 cost basis
      await expectErr(buy(carol, market, NO, 5 * U - 1), "BadAmount");
      await expectErr(buy(carol, market, NO, 10 * U, 10n ** 15n), "Slippage");
      await expectErr(buy(alice, market, 0, 10 * U), "BadSide");
    });

    it("cash out: early buyer sells at a profit after others buy the same side", async () => {
      const [daveShares, davePaid] = await buy(dave, market, NO, 20 * U);
      await buy(erin, market, NO, 300 * U);
      const got = await sell(dave, market, daveShares);
      assert(got > davePaid, `dave paid ${davePaid} and got ${got}`);
      const pos = (await position(market, dave))!;
      expect(pos.shares).to.eq(0n);
      expect(pos.cost).to.eq(0n);
    });

    it("cash out: partial sell, cost basis shrinks, guards", async () => {
      const before = (await position(market, alice))!;
      const half = before.shares / 2n;
      await sell(alice, market, half);
      const after = (await position(market, alice))!;
      expect(after.shares).to.eq(before.shares - half);
      expect(after.cost).to.eq(before.cost - (before.cost * half) / before.shares);
      await expectErr(sell(alice, market, after.shares + 1n), "NotEnoughShares");
      await expectErr(sell(alice, market, 1000n, 10n ** 12n), "Slippage");
      await expectErr(
        program.methods.sellShares(new BN(1), new BN(0)).accountsPartial(tradeAccounts(outsider, market)).signers([outsider]).rpc(),
        "NotEnoughShares"
      );
    });

    it("an emptied position may switch sides", async () => {
      await buy(dave, market, YES, 10 * U);
      expect((await position(market, dave))!.side).to.eq(YES);
    });

    it("no trading after the deadline, no early No, Void or unlocked Yes, non admin cannot resolve", async () => {
      await expectErr(resolve(market, NO), "TooEarly");
      await expectErr(resolve(market, VOID), "TooEarly");
      await expectErr(resolve(market, YES), "TooEarly"); // early Yes needs a lock first
      await expectErr(claim(alice, market), "NotClaimable");
      await waitUntil(endTs);
      await expectErr(buy(carol, market, NO, 10 * U), "BettingClosed");
      await expectErr(sell(carol, market, 1000n), "BettingClosed");
      await expectErr(resolve(market, YES, outsider), "Unauthorized");
    });

    it("resolve Yes: no claims or fees in the window, exact payouts after, no double claim", async () => {
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
      const left = await bal(vaultPda(market));
      assert(left < 10n, `only rounding dust should remain, got ${left}`);
    });
  });

  describe("lock, unlock, early Yes", () => {
    it("lock stops buying and selling, unlock reopens, Yes from Locked before the deadline", async () => {
      await setLimits(3);
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

    it("unlock fails after the deadline, No after the deadline, emergency void of a stuck lock", async () => {
      const a = await createMarket(creator, YES, 10 * U, 4);
      await review("approveMarket", a.market);
      await buy(bob, a.market, NO, 10 * U);
      await resolverIx("lockMarket", a.market);
      await waitUntil(a.endTs);
      await expectErr(resolverIx("unlockMarket", a.market), "DeadlinePassed");
      await resolveAndWait(a.market, NO);
      await claimAllAndCheck(a.market, [creator, bob]);
      await collectFees(a.market);

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

  describe("disputes", () => {
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

    it("emergency void of a dispute nobody settled", async () => {
      const { market, endTs } = await createMarket(creator, YES, 30 * U, 4);
      await review("approveMarket", market);
      await buy(bob, market, NO, 20 * U);
      await waitUntil(endTs);
      await resolve(market, YES);
      await dispute(bob, market);
      await waitUntil((await program.account.market.fetch(market)).disputeEnds.toNumber() + 6);
      await emergencyVoid(outsider, market);
      await claimAllAndCheck(market, [creator, bob]);
    });
  });

  describe("refunds and one sided markets", () => {
    it("nobody on the winning side: the other side splits the whole pot, no fee", async () => {
      const { market, endTs } = await createMarket(creator, YES, 20 * U, 4);
      await review("approveMarket", market);
      await buy(alice, market, YES, 30 * U);
      await waitUntil(endTs);
      await resolveAndWait(market, NO);
      await claimAllAndCheck(market, [creator, alice]);
      expect(await collectFees(market)).to.eq(0n);
    });

    it("nobody on the losing side: winners split their own pot, no fee", async () => {
      const { market, endTs } = await createMarket(creator, YES, 20 * U, 4);
      await review("approveMarket", market);
      await buy(alice, market, YES, 30 * U);
      await waitUntil(endTs);
      await resolveAndWait(market, YES);
      expect(feeFor(YES, await pools(market))).to.eq(0n);
      await claimAllAndCheck(market, [creator, alice]);
      expect(await collectFees(market)).to.eq(0n);
    });

    it("void refunds each side pro rata, even after cash outs", async () => {
      const { market } = await createMarket(creator, YES, 25 * U, 60);
      await review("approveMarket", market);
      const [aShares] = await buy(alice, market, YES, 40 * U);
      await buy(bob, market, NO, 35 * U);
      await sell(alice, market, aShares / 2n);
      await expectErr(review("voidMarket", market, outsider), "Unauthorized");
      await review("voidMarket", market);
      await expectErr(resolve(market, YES), "BadStatus");
      await claimAllAndCheck(market, [creator, alice, bob]);
      expect(await collectFees(market)).to.eq(0n); // both sides still have holders, nothing to sweep
      await expectErr(collectFees(market), "AlreadyClaimed");
    });

    it("resolve Void, reject, and cancel_pending all refund", async () => {
      const a = await createMarket(creator, NO, 10 * U, 4);
      await review("approveMarket", a.market);
      await buy(alice, a.market, YES, 10 * U);
      await waitUntil(a.endTs);
      await resolve(a.market, VOID);
      await claimAllAndCheck(a.market, [creator, alice]);

      const b = await createMarket(creator, YES, 40 * U, 60);
      await expectErr(review("rejectMarket", b.market, outsider), "Unauthorized");
      await review("rejectMarket", b.market);
      await expectErr(review("approveMarket", b.market), "BadStatus");
      await claimAllAndCheck(b.market, [creator]);

      const c = await createMarket(creator, NO, 12 * U, 60);
      await expectErr(
        program.methods.cancelPending().accountsPartial({ creator: outsider.publicKey, market: c.market }).signers([outsider]).rpc(),
        "Unauthorized"
      );
      await program.methods.cancelPending().accountsPartial({ creator: creator.publicKey, market: c.market }).signers([creator]).rpc();
      await claimAllAndCheck(c.market, [creator]);
    });

    it("emergency void of an open market nobody resolved", async () => {
      const { market, endTs } = await createMarket(creator, YES, 30 * U, 4);
      await review("approveMarket", market);
      await buy(bob, market, NO, 20 * U);
      await waitUntil(endTs);
      await expectErr(emergencyVoid(outsider, market), "TooEarly");
      await waitUntil(endTs + 6);
      await emergencyVoid(outsider, market);
      await claimAllAndCheck(market, [creator, bob]);
    });
  });

  describe("orphaned reserves (everyone on a side cashed out)", () => {
    it("void: the sold out side's retained fees go to the platform, holders get their side back", async () => {
      const { market } = await createMarket(creator, YES, 20 * U, 60);
      await review("approveMarket", market);
      const [bobShares] = await buy(bob, market, NO, 10 * U);
      await sell(bob, market, bobShares);
      const p = await pools(market);
      expect(p.ns).to.eq(0n);
      assert(p.nr > 0n, "sell fee stays in the No reserve");
      await expectErr(collectFees(market), "BadStatus"); // still open
      await review("voidMarket", market);
      expect(await claim(creator, market)).to.eq(p.yr);
      expect(await claim(bob, market)).to.eq(0n);
      expect(await collectFees(market)).to.eq(p.nr);
      expect(await bal(vaultPda(market))).to.eq(0n);
    });

    it("resolved with nobody holding either side: the platform takes the leftover fees", async () => {
      const { market, endTs } = await createMarket(creator, YES, 10 * U, 5);
      await review("approveMarket", market);
      const [aliceShares] = await buy(alice, market, NO, 10 * U);
      await sell(alice, market, aliceShares);
      await sell(creator, market, (await position(market, creator))!.shares);
      const p = await pools(market);
      expect(p.ys + p.ns).to.eq(0n);
      await waitUntil(endTs);
      await resolveAndWait(market, YES);
      expect(await claim(creator, market)).to.eq(0n);
      expect(await claim(alice, market)).to.eq(0n);
      expect(await collectFees(market)).to.eq(p.yr + p.nr);
      expect(await bal(vaultPda(market))).to.eq(0n);
    });

    it("rejected market with no cash outs has nothing to sweep", async () => {
      const { market } = await createMarket(creator, YES, 10 * U, 60);
      await review("rejectMarket", market);
      expect(await collectFees(market)).to.eq(0n);
      await claimAllAndCheck(market, [creator]);
    });
  });

  describe("lopsided pot", () => {
    it("fee is capped at the losing reserve, winners together get at least their own reserve", async () => {
      await setLimits(3);
      const { market, endTs } = await createMarket(creator, YES, 500 * U, 8);
      await review("approveMarket", market);
      await buy(alice, market, YES, 500 * U);
      await buy(bob, market, YES, 490 * U);
      await buy(carol, market, NO, 5 * U);
      await waitUntil(endTs);
      await resolveAndWait(market, YES);
      const p = await pools(market);
      const fee = feeFor(YES, p);
      expect(fee).to.eq(p.nr);
      let paid = 0n;
      for (const h of [creator, alice, bob]) paid += await claim(h, market);
      expect(await claim(carol, market)).to.eq(0n);
      assert(paid >= p.yr - 3n, "winners together get their own reserve, minus at most rounding");
      expect(await collectFees(market)).to.eq(fee);
      assert(paid + fee <= p.yr + p.nr);
    });
  });

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
      await expectErr(
        program.methods.approveMarket().accountsPartial({ admin: resolver.publicKey, config: configPda, market }).signers([resolver]).rpc(),
        "Unauthorized"
      );
      await review("approveMarket", market);
      await buy(bob, market, NO, 10 * U);
      await resolverIx("lockMarket", market, resolver, true);
      await resolverIx("unlockMarket", market, resolver, true);
      await resolverIx("lockMarket", market, resolver, true);
      await expectErr(resolverIx("unlockMarket", market, resolver, false), "Unauthorized");
      const asR = { admin: resolver.publicKey, config: configPda };
      await expectErr(program.methods.voidMarket().accountsPartial({ ...asR, market }).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(program.methods.settleDispute(YES).accountsPartial({ ...asR, market }).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(program.methods.setPaused(true).accountsPartial(asR).signers([resolver]).rpc(), "Unauthorized");
      await expectErr(setLimits(3, resolver), "Unauthorized");
      await expectErr(program.methods.setCurve(new BN(100_000), new BN(10_000)).accountsPartial(asR).signers([resolver]).rpc(), "Unauthorized");
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

  after(async () => {
    console.log(`    deposited ${deposited}, withdrawn ${withdrawn}, fees ${fees}`);
    assert(withdrawn + fees <= deposited, "never pays out more than was put in");
  });
});
