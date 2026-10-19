//! MemeMarkets: prediction markets for Solana memecoins with 2 or 3 outcomes, traded as shares.
//! Each outcome has its own price curve: the price rises as people buy it and falls as they sell.
//! Anyone can sell (cash out) while the market is open. At the end the winning outcome's shares split
//! the whole pot (every outcome's reserve) minus the platform fee. All money is USDC in a per market
//! vault PDA that only this program can move.
//!
//! Lifecycle:
//!   create_market -> (admin approves, unless creation is open or the admin created it)
//!   -> buy_shares / sell_shares ... -> lock -> resolve_market -> dispute window
//!   -> claim / claim_for (each holder) + collect_fees (anyone) + claim_creator_fee (anyone)
//!
//! Trust model: the admin key (or a limited resolver key) decides outcomes by reading prices off
//! chain, and the admin approves markets while creation is closed. Neither can withdraw from a
//! vault. Money only leaves a vault through sell_shares, claim, claim_for, collect_fees and
//! claim_creator_fee. If the admin disappears, anyone can void a stuck market after a delay and
//! everyone is refunded.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("BGCcEd1X76oZ2yF9nRoun2gGGLJC3D59Z2XEJNJ6KmhZ");

pub const BPS_DENOM: u128 = 10_000;
pub const MAX_FEE_BPS: u16 = 500;
pub const MAX_DURATION: i64 = 90 * 24 * 60 * 60; // 90 days
/// Upper bound on the dispute window so an admin cannot lock claims for years.
pub const MAX_DISPUTE_SECS: i64 = 7 * 24 * 60 * 60; // 7 days

#[cfg(not(feature = "short-time"))]
pub const MIN_DURATION: i64 = 60 * 60; // 1 hour
#[cfg(not(feature = "short-time"))]
pub const EMERGENCY_DELAY: i64 = 14 * 24 * 60 * 60; // 14 days

// Test build only (anchor build -- --features short-time). Never deploy this build.
#[cfg(feature = "short-time")]
pub const MIN_DURATION: i64 = 2;
#[cfg(feature = "short-time")]
pub const EMERGENCY_DELAY: i64 = 6;

/// Outcomes are numbered 1..=outcome_count. In a 2 outcome market, 1 is Yes and 2 is No.
pub const MAX_OUTCOMES: usize = 3;
pub const SIDE_YES: u8 = 1;
pub const SIDE_NO: u8 = 2;
/// resolve_market and settle_dispute take this to void a market (everyone refunded).
pub const RESULT_VOID: u8 = 4;

pub const METRIC_MCAP: u8 = 0;
pub const METRIC_PRICE: u8 = 1;
pub const DIR_ABOVE: u8 = 0;
pub const DIR_BELOW: u8 = 1;

/// One whole share is 1_000_000 share units, the same scale as USDC.
pub const SHARE_UNIT: u128 = 1_000_000;
/// Default curve: shares start at 0.10 USDC and each 1,000 shares bought add 0.10 USDC to the price.
pub const DEFAULT_CURVE_BASE: u64 = 100_000;
pub const DEFAULT_CURVE_DEPTH: u64 = 10_000;
pub const MIN_CURVE_BASE: u64 = 1_000; // 0.001 USDC
pub const MAX_CURVE_BASE: u64 = 1_000_000; // 1 USDC
pub const MIN_CURVE_DEPTH: u64 = 100;
pub const MAX_CURVE_DEPTH: u64 = 1_000_000_000;

/// Price curve for one outcome: price(x) = base + x / depth, in USDC base units per whole share,
/// where x is that outcome's share supply in share units.
/// The cost of moving supply from a to b is the area under the curve:
///   cost(a, b) = (2 * depth * base * (b - a) + b^2 - a^2) / (2 * depth * SHARE_UNIT)
fn curve_num(a: u128, b: u128, base: u128, depth: u128) -> Option<u128> {
    let lin = 2u128.checked_mul(depth)?.checked_mul(base)?.checked_mul(b.checked_sub(a)?)?;
    let quad = b.checked_mul(b)?.checked_sub(a.checked_mul(a)?)?;
    lin.checked_add(quad)
}

fn curve_den(depth: u128) -> Option<u128> {
    2u128.checked_mul(depth)?.checked_mul(SHARE_UNIT)
}

/// USDC charged to buy `n` shares when supply is `supply`. Rounded up, in the pool's favor.
pub fn buy_cost(supply: u64, n: u64, base: u64, depth: u64) -> Option<u64> {
    let a = supply as u128;
    let b = a.checked_add(n as u128)?;
    let num = curve_num(a, b, base as u128, depth as u128)?;
    let den = curve_den(depth as u128)?;
    u64::try_from(num.checked_add(den - 1)? / den).ok()
}

/// USDC value of selling `n` shares when supply is `supply`, before the sell fee. Rounded down.
pub fn sell_value(supply: u64, n: u64, base: u64, depth: u64) -> Option<u64> {
    let b = supply as u128;
    let a = b.checked_sub(n as u128)?;
    let num = curve_num(a, b, base as u128, depth as u128)?;
    u64::try_from(num / curve_den(depth as u128)?).ok()
}

fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Most shares `usdc` can buy at the current supply, and what they cost (never more than `usdc`).
/// Solves (b + k)^2 = (a + k)^2 + 2 * depth * SHARE_UNIT * usdc with k = depth * base.
pub fn shares_for_usdc(supply: u64, usdc: u64, base: u64, depth: u64) -> Option<(u64, u64)> {
    let a = supply as u128;
    let k = (depth as u128).checked_mul(base as u128)?;
    let ak = a.checked_add(k)?;
    let t = ak.checked_mul(ak)?.checked_add(curve_den(depth as u128)?.checked_mul(usdc as u128)?)?;
    let b = isqrt(t).checked_sub(k)?;
    let mut n = u64::try_from(b.checked_sub(a)?).ok()?;
    let mut cost = buy_cost(supply, n, base, depth)?;
    while n > 0 && cost > usdc {
        n -= 1;
        cost = buy_cost(supply, n, base, depth)?;
    }
    Some((n, cost))
}

/// Current price of one whole share of an outcome, in USDC base units.
pub fn spot_price(supply: u64, base: u64, depth: u64) -> u64 {
    base.saturating_add(supply / depth.max(1))
}

/// Pool state a payout depends on. Outcomes are 1 based; only the first `n` slots are used.
#[derive(Clone, Copy)]
pub struct Pools {
    pub n: u8,
    pub reserves: [u64; MAX_OUTCOMES],
    pub shares: [u64; MAX_OUTCOMES],
}

impl Pools {
    fn side(&self, outcome: u8) -> (u128, u128) {
        let i = (outcome as usize).saturating_sub(1).min(MAX_OUTCOMES - 1);
        (self.reserves[i] as u128, self.shares[i] as u128)
    }
    fn total(&self) -> Option<u128> {
        let mut t: u128 = 0;
        for i in 0..self.n as usize {
            t = t.checked_add(self.reserves[i] as u128)?;
        }
        Some(t)
    }
    /// Reserves of outcomes nobody holds (retained sell fees, bonus shares). No payout can reach them.
    fn orphaned(&self) -> Option<u128> {
        let mut t: u128 = 0;
        for i in 0..self.n as usize {
            if self.shares[i] == 0 {
                t = t.checked_add(self.reserves[i] as u128)?;
            }
        }
        Some(t)
    }
}

/// Platform fee for a resolved market.
/// Normal case: min(total * fee_bps / 10000, money on the losing outcomes).
/// If nobody holds the winning outcome, every holder is refunded their own outcome's reserve and the
/// fee is only the reserves nobody holds (no payout can reach them).
pub fn fee_for(result: u8, pools: &Pools, fee_bps: u16) -> Option<u64> {
    let (win_reserve, win_shares) = pools.side(result);
    if win_shares == 0 {
        return u64::try_from(pools.orphaned()?).ok();
    }
    let total = pools.total()?;
    let losing = total.checked_sub(win_reserve)?;
    u64::try_from((total.checked_mul(fee_bps as u128)? / BPS_DENOM).min(losing)).ok()
}

/// Payout for a position once a market is resolved.
/// Winners split the whole pot minus the fee, pro rata by shares. Losers get 0.
/// If nobody holds the winning outcome, everyone gets their own outcome's reserve back, pro rata.
pub fn payout_for(shares: u64, side: u8, result: u8, pools: &Pools, fee_bps: u16) -> Option<u64> {
    let (_, win_shares) = pools.side(result);
    if win_shares == 0 {
        return refund_for(shares, side, pools);
    }
    if side != result {
        return Some(0);
    }
    let pot = pools.total()?.checked_sub(fee_for(result, pools, fee_bps)? as u128)?;
    u64::try_from((shares as u128).checked_mul(pot)? / win_shares).ok()
}

/// Refund for a void or rejected market: each outcome's holders split that outcome's reserve.
pub fn refund_for(shares: u64, side: u8, pools: &Pools) -> Option<u64> {
    let (reserve, supply) = pools.side(side);
    if supply == 0 {
        return Some(0);
    }
    u64::try_from((shares as u128).checked_mul(reserve)? / supply).ok()
}

/// On a void or rejected market, outcomes nobody holds still hold their retained sell fees or bonus
/// share, which no refund can reach. The platform sweeps those through collect_fees.
pub fn orphaned_for(pools: &Pools) -> Option<u64> {
    u64::try_from(pools.orphaned()?).ok()
}

#[program]
pub mod mememarkets {
    use super::*;

    /// One time setup, only by the program's upgrade authority. Market creation starts closed
    /// (admin approval needed) with no creator fee share.
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16, min_bet: u64, max_bet: u64, dispute_secs: i64) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, MmError::BadConfig);
        require!(min_bet > 0 && max_bet >= min_bet, MmError::BadConfig);
        require!(dispute_secs >= 0 && dispute_secs <= MAX_DISPUTE_SECS, MmError::BadConfig);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.fee_vault = ctx.accounts.fee_vault.key();
        c.usdc_mint = ctx.accounts.usdc_mint.key();
        c.fee_bps = fee_bps;
        c.min_bet = min_bet;
        c.max_bet = max_bet;
        c.dispute_secs = dispute_secs;
        c.market_count = 0;
        c.paused = false;
        c.bump = ctx.bumps.config;
        c.curve_base = DEFAULT_CURVE_BASE;
        c.curve_depth = DEFAULT_CURVE_DEPTH;
        c.open_creation = false;
        c.creator_fee_share_bps = 0;
        Ok(())
    }

    pub fn set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        require!(new_admin != Pubkey::default(), MmError::BadConfig);
        ctx.accounts.config.admin = new_admin;
        Ok(())
    }

    /// Sets the resolver: a second key (for the price watcher server) that can only lock, unlock and
    /// resolve markets. Pass the zero key to turn it off. Admin keeps every power.
    pub fn set_resolver(ctx: Context<SetResolver>, resolver: Pubkey) -> Result<()> {
        let r = &mut ctx.accounts.resolver_config;
        r.resolver = resolver;
        r.bump = ctx.bumps.resolver_config;
        emit!(ResolverSet { resolver });
        Ok(())
    }

    /// Price curve for new markets: starting share price (USDC base units) and depth
    /// (share units per 1 base unit of price rise). Existing markets keep their curve.
    pub fn set_curve(ctx: Context<AdminOnly>, base: u64, depth: u64) -> Result<()> {
        require!((MIN_CURVE_BASE..=MAX_CURVE_BASE).contains(&base), MmError::BadConfig);
        require!((MIN_CURVE_DEPTH..=MAX_CURVE_DEPTH).contains(&depth), MmError::BadConfig);
        let c = &mut ctx.accounts.config;
        c.curve_base = base;
        c.curve_depth = depth;
        Ok(())
    }

    /// Staged rollout switches. open_creation: user created markets go live without approval.
    /// creator_fee_share_bps: share of each market's platform fee paid to its creator (0 to 10000,
    /// copied into each market at creation). Markets the admin creates never pay a creator share.
    pub fn set_creation(ctx: Context<AdminOnly>, open_creation: bool, creator_fee_share_bps: u16) -> Result<()> {
        require!(creator_fee_share_bps as u128 <= BPS_DENOM, MmError::BadConfig);
        let c = &mut ctx.accounts.config;
        c.open_creation = open_creation;
        c.creator_fee_share_bps = creator_fee_share_bps;
        Ok(())
    }

    /// Kill switch. Pauses new markets and all buying and selling. Claims and refunds always keep working.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// min_bet is the smallest buy, max_bet the most a wallet can have in one market (cost basis).
    /// Limits apply to new trades. Fee and dispute window apply to new markets only.
    pub fn set_limits(ctx: Context<AdminOnly>, fee_bps: u16, min_bet: u64, max_bet: u64, dispute_secs: i64) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, MmError::BadConfig);
        require!(min_bet > 0 && max_bet >= min_bet, MmError::BadConfig);
        require!(dispute_secs >= 0 && dispute_secs <= MAX_DISPUTE_SECS, MmError::BadConfig);
        let c = &mut ctx.accounts.config;
        c.fee_bps = fee_bps;
        c.min_bet = min_bet;
        c.max_bet = max_bet;
        c.dispute_secs = dispute_secs;
        Ok(())
    }

    /// Creates a market with 2 or 3 outcomes. The creator's seed is a prize pot, not a bet: it is split
    /// evenly across the outcomes (like add_bonus), mints no shares and creates no position, so every
    /// market starts at even odds. Users must seed at least min_bet; the admin may seed 0.
    /// Admin created markets open right away and are Verified. Other markets open right away when
    /// creation is open, otherwise they wait in Pending for admin approval (and get the seed back if
    /// rejected or cancelled). rules_hash is the sha256 of the full rules text, fixed at creation.
    #[allow(clippy::too_many_arguments)]
    pub fn create_market(
        ctx: Context<CreateMarket>,
        token_mint: Pubkey,
        metric: u8,
        direction: u8,
        target: u64,
        target_decimals: u8,
        end_ts: i64,
        outcome_count: u8,
        seed_amount: u64,
        rules_hash: [u8; 32],
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(!cfg.paused, MmError::Paused);
        require!(outcome_count == 2 || outcome_count as usize == MAX_OUTCOMES, MmError::BadParams);
        require!(metric == METRIC_MCAP || metric == METRIC_PRICE, MmError::BadParams);
        require!(direction == DIR_ABOVE || direction == DIR_BELOW, MmError::BadParams);
        require!(target_decimals <= 18, MmError::BadParams);
        require!(outcome_count != 2 || target > 0, MmError::BadParams);
        let now = Clock::get()?.unix_timestamp;
        require!(end_ts >= now + MIN_DURATION && end_ts <= now + MAX_DURATION, MmError::BadDeadline);

        let creator = ctx.accounts.creator.key();
        let by_admin = creator == cfg.admin;
        require!(seed_amount <= cfg.max_bet, MmError::BadAmount);
        require!(by_admin || seed_amount >= cfg.min_bet, MmError::BadAmount);
        let m = &mut ctx.accounts.market;
        m.id = cfg.market_count;
        m.creator = creator;
        m.token_mint = token_mint;
        m.metric = metric;
        m.direction = direction;
        m.target = target;
        m.target_decimals = target_decimals;
        m.end_ts = end_ts;
        m.created_ts = now;
        m.status = if by_admin || cfg.open_creation { MarketStatus::Open } else { MarketStatus::Pending };
        m.result = 0;
        m.outcome_count = outcome_count;
        m.reserves = split_evenly(seed_amount, outcome_count)?;
        m.shares = [0; MAX_OUTCOMES];
        m.curve_base = cfg.curve_base;
        m.curve_depth = cfg.curve_depth;
        m.fee_bps = cfg.fee_bps;
        m.creator_fee_bps = if by_admin { 0 } else { cfg.creator_fee_share_bps };
        m.creator_fee_owed = 0;
        m.creator_fee_paid = false;
        m.dispute_secs = cfg.dispute_secs;
        m.resolved_ts = 0;
        m.dispute_ends = 0;
        m.disputed = false;
        m.fee_collected = false;
        m.verified = by_admin;
        m.rules_hash = rules_hash;
        m.final_value = 0;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.vault;
        cfg.market_count = cfg.market_count.checked_add(1).ok_or(MmError::Math)?;

        let b = &mut ctx.accounts.bonus;
        b.market = m.key();
        b.total = seed_amount;
        b.bump = ctx.bumps.bonus;

        if seed_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.creator_usdc.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.creator.to_account_info(),
                    },
                ),
                seed_amount,
            )?;
        }
        emit!(MarketCreated {
            market: m.key(),
            id: m.id,
            creator,
            token_mint,
            end_ts,
            outcome_count,
            verified: m.verified,
            pending: m.status == MarketStatus::Pending,
            rules_hash,
        });
        emit!(BonusAdded { market: m.key(), funder: creator, amount: seed_amount, total_bonus: seed_amount });
        Ok(())
    }

    pub fn approve_market(ctx: Context<ReviewMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Pending, MmError::BadStatus);
        require!(Clock::get()?.unix_timestamp < m.end_ts, MmError::BadDeadline);
        m.status = MarketStatus::Open;
        Ok(())
    }

    /// Admin rejects a Pending market. The creator's seed goes straight back to the creator.
    pub fn reject_market(ctx: Context<CloseCreation>) -> Result<()> {
        require!(ctx.accounts.config.admin == ctx.accounts.signer.key(), MmError::Unauthorized);
        refund_seed(ctx.accounts)
    }

    /// Admin marks a market as Verified (official, promoted) or removes the badge. Display only.
    pub fn set_verified(ctx: Context<ReviewMarket>, verified: bool) -> Result<()> {
        ctx.accounts.market.verified = verified;
        Ok(())
    }

    /// Freezes trading the moment the target looks hit, so nobody can trade on a known outcome
    /// while the resolver confirms it. The lock time is kept in resolved_ts while Locked.
    pub fn lock_market(ctx: Context<ResolverAction>) -> Result<()> {
        ctx.accounts.check()?;
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Open, MmError::BadStatus);
        m.status = MarketStatus::Locked;
        m.resolved_ts = Clock::get()?.unix_timestamp;
        emit!(MarketLocked { market: m.key(), locked: true });
        Ok(())
    }

    /// False alarm: reopen trading. Only before the deadline.
    pub fn unlock_market(ctx: Context<ResolverAction>) -> Result<()> {
        ctx.accounts.check()?;
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Locked, MmError::BadStatus);
        require!(Clock::get()?.unix_timestamp < m.end_ts, MmError::DeadlinePassed);
        m.status = MarketStatus::Open;
        m.resolved_ts = 0;
        emit!(MarketLocked { market: m.key(), locked: false });
        Ok(())
    }

    /// The creator pulls a market that nobody approved yet. The seed goes straight back to them.
    pub fn cancel_pending(ctx: Context<CloseCreation>) -> Result<()> {
        require!(ctx.accounts.market.creator == ctx.accounts.signer.key(), MmError::Unauthorized);
        refund_seed(ctx.accounts)
    }

    /// Buy shares of one outcome with `usdc_in` USDC at the curve price. Reverts if fewer than
    /// `min_shares_out` shares would be received (slippage guard). Only while Open, before the deadline.
    pub fn buy_shares(ctx: Context<Trade>, side: u8, usdc_in: u64, min_shares_out: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, MmError::Paused);
        require!(usdc_in >= cfg.min_bet, MmError::BadAmount);
        let m = &mut ctx.accounts.market;
        let user = ctx.accounts.user.key();
        require!(user != m.creator && user != cfg.admin, MmError::CreatorCannotTrade);
        require!(side >= 1 && side <= m.outcome_count, MmError::BadSide);
        require!(m.status == MarketStatus::Open, MmError::BadStatus);
        require!(Clock::get()?.unix_timestamp < m.end_ts, MmError::BettingClosed);

        let p = &mut ctx.accounts.position;
        if p.user == Pubkey::default() {
            p.market = m.key();
            p.user = ctx.accounts.user.key();
            p.side = side;
            p.shares = 0;
            p.cost = 0;
            p.claimed = false;
            p.bump = ctx.bumps.position;
        }
        let (shares, paid) = apply_buy(m, p, side, usdc_in, min_shares_out, cfg.max_bet)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            paid,
        )?;
        emit_trade(m.key(), m, p.user, side, true, shares, paid);
        Ok(())
    }

    /// Cash out: sell `shares` back to the curve at the current price, minus the market fee, which
    /// stays in the pot for the eventual winners. Reverts if the user would get less than
    /// `min_usdc_out`. Only while Open, before the deadline.
    pub fn sell_shares(ctx: Context<Trade>, shares: u64, min_usdc_out: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, MmError::Paused);
        require!(shares > 0, MmError::BadAmount);
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Open, MmError::BadStatus);
        require!(Clock::get()?.unix_timestamp < m.end_ts, MmError::BettingClosed);
        let p = &mut ctx.accounts.position;
        require!(p.shares >= shares, MmError::NotEnoughShares);
        require!(p.user == ctx.accounts.user.key(), MmError::Unauthorized);
        let side = p.side;
        let i = (side - 1) as usize;

        let gross = sell_value(m.shares[i], shares, m.curve_base, m.curve_depth).ok_or(MmError::Math)?;
        let fee = u64::try_from((gross as u128) * (m.fee_bps as u128) / BPS_DENOM).map_err(|_| MmError::Math)?;
        let out = gross.checked_sub(fee).ok_or(MmError::Math)?;
        require!(out > 0, MmError::BadAmount);
        require!(out >= min_usdc_out, MmError::Slippage);

        m.shares[i] = m.shares[i].checked_sub(shares).ok_or(MmError::Math)?;
        m.reserves[i] = m.reserves[i].checked_sub(out).ok_or(MmError::Math)?;
        // Cost basis shrinks in proportion to the shares sold.
        let cost_out = if shares == p.shares {
            p.cost
        } else {
            u64::try_from((p.cost as u128) * (shares as u128) / (p.shares as u128)).map_err(|_| MmError::Math)?
        };
        p.cost = p.cost.checked_sub(cost_out).ok_or(MmError::Math)?;
        p.shares -= shares;

        let id = m.id.to_le_bytes();
        let bump = [m.bump];
        let seeds: &[&[&[u8]]] = &[&[b"market", id.as_ref(), bump.as_ref()]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: m.to_account_info(),
                },
                seeds,
            ),
            out,
        )?;
        emit_trade(m.key(), m, p.user, side, false, shares, out);
        Ok(())
    }

    /// Bonus pot: anyone (normally the platform treasury, funded by creator fees) adds USDC to a
    /// market without taking a side. No shares are minted and no position is created, so the funder
    /// cannot win it back. It is split evenly across the outcome reserves, which means the winners
    /// receive it on resolution (and on a void each outcome's holders get its share back).
    /// Only while the market is Open.
    pub fn add_bonus(ctx: Context<AddBonus>, amount: u64) -> Result<()> {
        require!(amount > 0, MmError::BadAmount);
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Open, MmError::BadStatus);
        let add = split_evenly(amount, m.outcome_count)?;
        for i in 0..m.outcome_count as usize {
            m.reserves[i] = m.reserves[i].checked_add(add[i]).ok_or(MmError::Math)?;
        }
        let b = &mut ctx.accounts.bonus;
        if b.market == Pubkey::default() {
            b.market = m.key();
            b.bump = ctx.bumps.bonus;
        }
        b.total = b.total.checked_add(amount).ok_or(MmError::Math)?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.funder_usdc.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(BonusAdded { market: m.key(), funder: ctx.accounts.funder.key(), amount, total_bonus: b.total });
        Ok(())
    }

    /// Sets the outcome. result: 1..=outcome_count, or 4 to void.
    /// After the deadline: from Open or Locked, any result.
    /// Before the deadline: only from Locked (trading already frozen). In a 2 outcome market only
    /// Yes can resolve early, since No means the target was not hit in time.
    /// final_value is the value the resolver read off chain, stored for the public record.
    pub fn resolve_market(ctx: Context<ResolverAction>, result: u8, final_value: u64) -> Result<()> {
        ctx.accounts.check()?;
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        require!(result == RESULT_VOID || (result >= 1 && result <= m.outcome_count), MmError::BadParams);
        require!(m.status == MarketStatus::Open || m.status == MarketStatus::Locked, MmError::BadStatus);
        let early_ok = m.status == MarketStatus::Locked
            && result != RESULT_VOID
            && (m.outcome_count as usize == MAX_OUTCOMES || result == SIDE_YES);
        require!(now >= m.end_ts || early_ok, MmError::TooEarly);
        m.final_value = final_value;
        m.resolved_ts = now;
        if result == RESULT_VOID {
            m.status = MarketStatus::Void;
        } else {
            m.status = MarketStatus::Resolved;
            m.result = result;
            m.dispute_ends = now.checked_add(m.dispute_secs).ok_or(MmError::Math)?;
        }
        emit!(MarketResolved { market: m.key(), result, final_value });
        Ok(())
    }

    /// Admin can cancel an open or locked market at any time, for example a rugged token or
    /// manipulation. Everyone is refunded.
    pub fn void_market(ctx: Context<ReviewMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Open || m.status == MarketStatus::Locked, MmError::BadStatus);
        m.status = MarketStatus::Void;
        m.resolved_ts = Clock::get()?.unix_timestamp;
        emit!(MarketResolved { market: m.key(), result: RESULT_VOID, final_value: 0 });
        Ok(())
    }

    /// Any holder in the market can freeze payouts during the dispute window.
    pub fn dispute_market(ctx: Context<DisputeMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Resolved, MmError::BadStatus);
        require!(!m.disputed, MmError::BadStatus);
        require!(Clock::get()?.unix_timestamp < m.dispute_ends, MmError::DisputeClosed);
        m.disputed = true;
        emit!(MarketDisputed { market: m.key(), by: ctx.accounts.user.key() });
        Ok(())
    }

    /// Admin decides a dispute: 1..=outcome_count, or 4 to void. Payouts open right away after.
    pub fn settle_dispute(ctx: Context<ResolveMarket>, result: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        require!(result == RESULT_VOID || (result >= 1 && result <= m.outcome_count), MmError::BadParams);
        require!(m.status == MarketStatus::Resolved && m.disputed, MmError::BadStatus);
        m.disputed = false;
        m.dispute_ends = now;
        if result == RESULT_VOID {
            m.status = MarketStatus::Void;
        } else {
            m.result = result;
        }
        emit!(MarketResolved { market: m.key(), result, final_value: m.final_value });
        Ok(())
    }

    /// Safety valve. If nobody resolves (open or locked), or nobody settles a dispute, anyone can
    /// void the market after a delay. Everyone is then refunded.
    pub fn emergency_void(ctx: Context<EmergencyVoid>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        let stuck_open = m.status == MarketStatus::Open && now > m.end_ts + EMERGENCY_DELAY;
        // Locked: whichever comes first, 14 days after the lock or 14 days after the deadline.
        let stuck_locked = m.status == MarketStatus::Locked
            && (now > m.resolved_ts + EMERGENCY_DELAY || now > m.end_ts + EMERGENCY_DELAY);
        let stuck_dispute = m.status == MarketStatus::Resolved && m.disputed && now > m.dispute_ends + EMERGENCY_DELAY;
        require!(stuck_open || stuck_locked || stuck_dispute, MmError::TooEarly);
        m.status = MarketStatus::Void;
        m.disputed = false;
        m.resolved_ts = now;
        emit!(MarketResolved { market: m.key(), result: RESULT_VOID, final_value: 0 });
        Ok(())
    }

    /// Pays a winner, or refunds a stake on a void or rejected market. Pays the signer's own wallet only.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let a = ctx.accounts;
        pay_out(&a.market, &mut a.position, &a.vault, &a.user_usdc, &a.token_program)
    }

    /// Automatic payout: anyone (normally the price watcher) can pay a holder's payout or refund
    /// into that holder's own USDC account. The money can only go to a token account owned by the
    /// position's owner, so the caller cannot redirect it. Same rules and timing as claim.
    pub fn claim_for(ctx: Context<ClaimFor>) -> Result<()> {
        let a = ctx.accounts;
        pay_out(&a.market, &mut a.position, &a.vault, &a.owner_usdc, &a.token_program)
    }

    /// Sends the platform fee, once per market: on a resolved market after the dispute window, or on
    /// a void or rejected market (sweeps reserves of outcomes nobody holds). The market's creator
    /// share of that fee stays in the vault as creator_fee_owed for claim_creator_fee.
    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        require!(!m.fee_collected, MmError::AlreadyClaimed);
        let pools = m.pools();
        let fee = match m.status {
            MarketStatus::Resolved => {
                require!(!m.disputed && now >= m.dispute_ends, MmError::NotClaimable);
                fee_for(m.result, &pools, m.fee_bps).ok_or(MmError::Math)?
            }
            MarketStatus::Void | MarketStatus::Rejected => orphaned_for(&pools).ok_or(MmError::Math)?,
            _ => return err!(MmError::BadStatus),
        };
        let creator_part = u64::try_from((fee as u128) * (m.creator_fee_bps as u128) / BPS_DENOM).map_err(|_| MmError::Math)?;
        let platform_part = fee.checked_sub(creator_part).ok_or(MmError::Math)?;
        m.fee_collected = true;
        m.creator_fee_owed = creator_part;
        if platform_part > 0 {
            let id = m.id.to_le_bytes();
            let bump = [m.bump];
            let seeds: &[&[&[u8]]] = &[&[b"market", id.as_ref(), bump.as_ref()]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.fee_vault.to_account_info(),
                        authority: m.to_account_info(),
                    },
                    seeds,
                ),
                platform_part,
            )?;
        }
        emit!(FeesCollected { market: m.key(), platform: platform_part, creator: creator_part });
        Ok(())
    }

    /// Pays the market creator's fee share into the creator's own USDC account. Anyone can call it
    /// (normally the watcher), once, after collect_fees.
    pub fn claim_creator_fee(ctx: Context<ClaimCreatorFee>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.fee_collected, MmError::NotClaimable);
        require!(!m.creator_fee_paid, MmError::AlreadyClaimed);
        let amount = m.creator_fee_owed;
        m.creator_fee_paid = true;
        if amount > 0 {
            let id = m.id.to_le_bytes();
            let bump = [m.bump];
            let seeds: &[&[&[u8]]] = &[&[b"market", id.as_ref(), bump.as_ref()]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.creator_usdc.to_account_info(),
                        authority: m.to_account_info(),
                    },
                    seeds,
                ),
                amount,
            )?;
        }
        emit!(CreatorFeePaid { market: m.key(), creator: m.creator, amount });
        Ok(())
    }
}

/// Splits `amount` evenly over the first `n` outcomes; the last outcome takes the remainder.
fn split_evenly(amount: u64, n: u8) -> Result<[u64; MAX_OUTCOMES]> {
    let n = n as usize;
    let part = amount / n as u64;
    let mut out = [0u64; MAX_OUTCOMES];
    for (i, slot) in out.iter_mut().enumerate().take(n) {
        *slot = if i == n - 1 { amount.checked_sub(part * (n as u64 - 1)).ok_or(MmError::Math)? } else { part };
    }
    Ok(out)
}

/// Shared by reject_market and cancel_pending: a Pending market only ever holds the creator's seed
/// (no trades or bonuses are possible before it opens), so the whole vault goes back to the creator.
fn refund_seed(a: &mut CloseCreation) -> Result<()> {
    let m = &mut a.market;
    require!(m.status == MarketStatus::Pending, MmError::BadStatus);
    let amount = a.vault.amount;
    m.status = MarketStatus::Rejected;
    m.reserves = [0; MAX_OUTCOMES];
    a.bonus.total = 0;
    if amount > 0 {
        let id = m.id.to_le_bytes();
        let bump = [m.bump];
        let seeds: &[&[&[u8]]] = &[&[b"market", id.as_ref(), bump.as_ref()]];
        token::transfer(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                Transfer { from: a.vault.to_account_info(), to: a.creator_usdc.to_account_info(), authority: m.to_account_info() },
                seeds,
            ),
            amount,
        )?;
    }
    emit!(MarketResolved { market: m.key(), result: RESULT_VOID, final_value: 0 });
    Ok(())
}

/// Prices a buy, updates market and position, returns
/// (shares bought, USDC to transfer in).
fn apply_buy(m: &mut Market, p: &mut Position, side: u8, usdc_in: u64, min_shares_out: u64, max_bet: u64) -> Result<(u64, u64)> {
    if p.shares == 0 {
        p.side = side; // an empty position may switch outcomes
    }
    require!(p.side == side, MmError::OtherSide);
    let i = (side - 1) as usize;
    let (shares, paid) = shares_for_usdc(m.shares[i], usdc_in, m.curve_base, m.curve_depth).ok_or(MmError::Math)?;
    require!(shares > 0, MmError::BadAmount);
    require!(shares >= min_shares_out, MmError::Slippage);
    let new_cost = p.cost.checked_add(paid).ok_or(MmError::Math)?;
    require!(new_cost <= max_bet, MmError::OverMax);
    p.cost = new_cost;
    p.shares = p.shares.checked_add(shares).ok_or(MmError::Math)?;
    m.shares[i] = m.shares[i].checked_add(shares).ok_or(MmError::Math)?;
    m.reserves[i] = m.reserves[i].checked_add(paid).ok_or(MmError::Math)?;
    Ok((shares, paid))
}

/// Shared by claim and claim_for: works out the payout or refund, marks the position claimed,
/// and moves the USDC from the vault to `to`, which the caller's context has already proven
/// belongs to the position's owner.
fn pay_out<'info>(
    market: &Account<'info, Market>,
    position: &mut Account<'info, Position>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!position.claimed, MmError::AlreadyClaimed);
    let pools = market.pools();
    let payout = match market.status {
        MarketStatus::Void | MarketStatus::Rejected => refund_for(position.shares, position.side, &pools).ok_or(MmError::Math)?,
        MarketStatus::Resolved => {
            require!(!market.disputed && now >= market.dispute_ends, MmError::NotClaimable);
            payout_for(position.shares, position.side, market.result, &pools, market.fee_bps).ok_or(MmError::Math)?
        }
        _ => return err!(MmError::NotClaimable),
    };
    position.claimed = true;
    if payout > 0 {
        let id = market.id.to_le_bytes();
        let bump = [market.bump];
        let seeds: &[&[&[u8]]] = &[&[b"market", id.as_ref(), bump.as_ref()]];
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer { from: vault.to_account_info(), to: to.to_account_info(), authority: market.to_account_info() },
                seeds,
            ),
            payout,
        )?;
    }
    emit!(Claimed { market: market.key(), user: position.user, amount: payout });
    Ok(())
}

fn emit_trade(market: Pubkey, m: &Market, user: Pubkey, side: u8, buy: bool, shares: u64, usdc: u64) {
    let mut prices = [0u64; MAX_OUTCOMES];
    for (i, price) in prices.iter_mut().enumerate().take(m.outcome_count as usize) {
        *price = spot_price(m.shares[i], m.curve_base, m.curve_depth);
    }
    emit!(Traded { market, user, side, buy, shares, usdc, reserves: m.reserves, supplies: m.shares, prices });
}

impl Market {
    pub fn pools(&self) -> Pools {
        Pools { n: self.outcome_count, reserves: self.reserves, shares: self.shares }
    }
}

// ───────────────────────────── accounts ─────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub fee_vault: Pubkey,
    pub usdc_mint: Pubkey,
    pub fee_bps: u16,
    pub min_bet: u64,
    pub max_bet: u64,
    pub dispute_secs: i64,
    pub market_count: u64,
    pub paused: bool,
    pub bump: u8,
    /// Starting share price for new markets, USDC base units per whole share.
    pub curve_base: u64,
    /// Share units bought per 1 base unit of price rise, for new markets.
    pub curve_depth: u64,
    /// When true, markets created by anyone go live without admin approval.
    pub open_creation: bool,
    /// Share of each new user created market's platform fee paid to its creator, in bps of the fee.
    pub creator_fee_share_bps: u16,
}

/// Running total of bonus USDC added to one market, PDA ["bonus", market]. Informational: payouts
/// already include the bonus through the reserves. Lets the app show it and exclude it from odds.
#[account]
#[derive(InitSpace)]
pub struct MarketBonus {
    pub market: Pubkey,
    pub total: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ResolverConfig {
    /// Key allowed to lock, unlock and resolve. Zero key means no resolver.
    pub resolver: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Pending,
    Open,
    Resolved,
    Void,
    Rejected,
    /// Trading frozen while the resolver confirms a result.
    Locked,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub id: u64,
    pub creator: Pubkey,
    pub token_mint: Pubkey,
    pub metric: u8,
    pub direction: u8,
    pub target: u64,
    pub target_decimals: u8,
    pub end_ts: i64,
    pub created_ts: i64,
    pub status: MarketStatus,
    /// Winning outcome (1..=outcome_count) once Resolved, 0 before.
    pub result: u8,
    /// 2 (Yes, No) or 3.
    pub outcome_count: u8,
    /// USDC held for each outcome: bought in minus sold out, plus sell fees and bonus. Unused slots are 0.
    pub reserves: [u64; MAX_OUTCOMES],
    /// Share supply per outcome (share units, 1_000_000 per share).
    pub shares: [u64; MAX_OUTCOMES],
    /// Price curve copied from config at creation.
    pub curve_base: u64,
    pub curve_depth: u64,
    pub fee_bps: u16,
    /// Creator's share of the platform fee, in bps of the fee, copied at creation (0 for admin markets).
    pub creator_fee_bps: u16,
    /// Creator share set aside by collect_fees, paid by claim_creator_fee.
    pub creator_fee_owed: u64,
    pub creator_fee_paid: bool,
    /// Dispute window copied from config at creation.
    pub dispute_secs: i64,
    /// Time of the last lock, resolve or void. Holds the lock time while Locked.
    pub resolved_ts: i64,
    pub dispute_ends: i64,
    pub disputed: bool,
    pub fee_collected: bool,
    /// Official market badge. True for markets the admin created, admin can change it.
    pub verified: bool,
    /// sha256 of the market's full rules text, fixed at creation.
    pub rules_hash: [u8; 32],
    pub final_value: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub user: Pubkey,
    /// Outcome held, 1..=outcome_count.
    pub side: u8,
    /// Shares held (share units).
    pub shares: u64,
    /// Net USDC put in (cost basis), reduced in proportion when shares are sold. For limits and P&L.
    pub cost: u64,
    pub claimed: bool,
    pub bump: u8,
}

// ───────────────────────────── contexts ─────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Must be the program's upgrade authority, so nobody can front run the setup after deploy.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = usdc_mint.decimals == 6 @ MmError::BadConfig)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(constraint = fee_vault.mint == usdc_mint.key() @ MmError::BadConfig)]
    pub fee_vault: Account<'info, TokenAccount>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ MmError::Unauthorized)]
    pub program: Program<'info, crate::program::Mememarkets>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ MmError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ MmError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init, payer = creator, space = 8 + Market::INIT_SPACE,
        seeds = [b"market", config.market_count.to_le_bytes().as_ref()], bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init, payer = creator,
        seeds = [b"vault", market.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = market
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = creator, space = 8 + MarketBonus::INIT_SPACE,
        seeds = [b"bonus", market.key().as_ref()], bump
    )]
    pub bonus: Account<'info, MarketBonus>,
    #[account(mut, token::mint = usdc_mint, token::authority = creator)]
    pub creator_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReviewMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ MmError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ MmError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
}

/// Signed by the admin or the resolver. resolver_config may be left out when the admin signs.
#[derive(Accounts)]
pub struct ResolverAction<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"resolver"], bump = resolver_config.bump)]
    pub resolver_config: Option<Account<'info, ResolverConfig>>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
}

impl ResolverAction<'_> {
    fn check(&self) -> Result<()> {
        let who = self.authority.key();
        let is_resolver = self
            .resolver_config
            .as_ref()
            .is_some_and(|r| r.resolver != Pubkey::default() && r.resolver == who);
        require!(who == self.config.admin || is_resolver, MmError::Unauthorized);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SetResolver<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ MmError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed, payer = admin, space = 8 + ResolverConfig::INIT_SPACE,
        seeds = [b"resolver"], bump
    )]
    pub resolver_config: Account<'info, ResolverConfig>,
    pub system_program: Program<'info, System>,
}

/// reject_market (signer must be the admin) and cancel_pending (signer must be the creator).
/// The seed refund can only go to a USDC account owned by the market's creator.
#[derive(Accounts)]
pub struct CloseCreation<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"bonus", market.key().as_ref()], bump = bonus.bump)]
    pub bonus: Account<'info, MarketBonus>,
    /// CHECK: must be the market's creator; only used to check who owns creator_usdc.
    #[account(address = market.creator @ MmError::Unauthorized)]
    pub creator: UncheckedAccount<'info>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = creator)]
    pub creator_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = user, space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()], bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = user)]
    pub user_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddBonus<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = funder, space = 8 + MarketBonus::INIT_SPACE,
        seeds = [b"bonus", market.key().as_ref()], bump
    )]
    pub bonus: Account<'info, MarketBonus>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = funder)]
    pub funder_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DisputeMarket<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()], bump = position.bump,
        constraint = position.shares > 0 @ MmError::Unauthorized
    )]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct EmergencyVoid<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut, seeds = [b"position", market.key().as_ref(), user.key().as_ref()], bump = position.bump,
        constraint = position.user == user.key() @ MmError::Unauthorized
    )]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = user)]
    pub user_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimFor<'info> {
    /// Anyone. Pays only the transaction fee; receives nothing.
    pub caller: Signer<'info>,
    /// CHECK: the position owner. Only used to derive the position PDA and to check who owns
    /// owner_usdc. Does not sign and receives nothing directly.
    pub owner: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut, seeds = [b"position", market.key().as_ref(), owner.key().as_ref()], bump = position.bump,
        constraint = position.user == owner.key() @ MmError::Unauthorized
    )]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub owner_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, address = config.fee_vault)]
    pub fee_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimCreatorFee<'info> {
    /// Anyone. Pays only the transaction fee; receives nothing.
    pub caller: Signer<'info>,
    /// CHECK: must be the market's creator; only used to check who owns creator_usdc.
    #[account(address = market.creator @ MmError::Unauthorized)]
    pub creator: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = creator)]
    pub creator_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ───────────────────────────── events and errors ─────────────────────────────

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub id: u64,
    pub creator: Pubkey,
    pub token_mint: Pubkey,
    pub end_ts: i64,
    pub outcome_count: u8,
    pub verified: bool,
    pub pending: bool,
    pub rules_hash: [u8; 32],
}

#[event]
pub struct Traded {
    pub market: Pubkey,
    pub user: Pubkey,
    pub side: u8,
    /// true for a buy, false for a sell (cash out)
    pub buy: bool,
    pub shares: u64,
    /// USDC paid in (buy) or paid out after the fee (sell)
    pub usdc: u64,
    pub reserves: [u64; MAX_OUTCOMES],
    pub supplies: [u64; MAX_OUTCOMES],
    /// Spot price per outcome after the trade, USDC base units per whole share (0 for unused slots)
    pub prices: [u64; MAX_OUTCOMES],
}

#[event]
pub struct BonusAdded {
    pub market: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
    pub total_bonus: u64,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub result: u8,
    pub final_value: u64,
}

#[event]
pub struct ResolverSet {
    pub resolver: Pubkey,
}

#[event]
pub struct MarketLocked {
    pub market: Pubkey,
    pub locked: bool,
}

#[event]
pub struct MarketDisputed {
    pub market: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FeesCollected {
    pub market: Pubkey,
    pub platform: u64,
    pub creator: u64,
}

#[event]
pub struct CreatorFeePaid {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum MmError {
    #[msg("Not allowed")]
    Unauthorized,
    #[msg("Trading is paused")]
    Paused,
    #[msg("Bad config values")]
    BadConfig,
    #[msg("Bad market parameters")]
    BadParams,
    #[msg("That outcome does not exist in this market")]
    BadSide,
    #[msg("Amount is outside the allowed range")]
    BadAmount,
    #[msg("Deadline must be 1 hour to 90 days away")]
    BadDeadline,
    #[msg("Market is not in the right status")]
    BadStatus,
    #[msg("Trading is closed for this market")]
    BettingClosed,
    #[msg("You hold shares of another outcome in this market. Sell them first")]
    OtherSide,
    #[msg("Over the per wallet maximum for this market")]
    OverMax,
    #[msg("Too early")]
    TooEarly,
    #[msg("Dispute window is closed")]
    DisputeClosed,
    #[msg("Nothing to claim yet")]
    NotClaimable,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Math error")]
    Math,
    #[msg("Deadline has passed")]
    DeadlinePassed,
    #[msg("Price moved: you would get less than your minimum")]
    Slippage,
    #[msg("You do not have that many shares")]
    NotEnoughShares,
    #[msg("The market creator and the admin cannot trade in this market")]
    CreatorCannotTrade,
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: u64 = 1_000_000; // 1 USDC, also 1 share
    const B: u64 = DEFAULT_CURVE_BASE;
    const D: u64 = DEFAULT_CURVE_DEPTH;

    fn p2(yr: u64, nr: u64, ys: u64, ns: u64) -> Pools {
        Pools { n: 2, reserves: [yr, nr, 0], shares: [ys, ns, 0] }
    }
    fn p3(r: [u64; 3], s: [u64; 3]) -> Pools {
        Pools { n: 3, reserves: r, shares: s }
    }

    #[test]
    fn first_thousand_shares_cost_150_usdc() {
        assert_eq!(buy_cost(0, 1_000 * U, B, D).unwrap(), 150 * U);
        assert_eq!(spot_price(0, B, D), 100_000);
        assert_eq!(spot_price(1_000 * U, B, D), 200_000);
    }

    #[test]
    fn shares_for_usdc_never_overspends_and_is_tight() {
        for supply in [0u64, 7, 1_234_567, 999 * U, 50_000 * U] {
            for usdc in [5 * U, 5 * U + 1, 77_777_777, 500 * U] {
                let (n, cost) = shares_for_usdc(supply, usdc, B, D).unwrap();
                assert!(cost <= usdc);
                assert_eq!(cost, buy_cost(supply, n, B, D).unwrap());
                assert!(buy_cost(supply, n + 1, B, D).unwrap() > usdc);
            }
        }
    }

    #[test]
    fn buy_then_sell_never_profits() {
        for supply in [0u64, 123, 10_000 * U] {
            let (n, cost) = shares_for_usdc(supply, 50 * U, B, D).unwrap();
            let back = sell_value(supply + n, n, B, D).unwrap();
            assert!(back <= cost, "round trip made money: paid {} got {}", cost, back);
        }
    }

    #[test]
    fn early_buyer_profits_when_others_buy_after() {
        let (a, a_cost) = shares_for_usdc(0, 50 * U, B, D).unwrap();
        let (b, _) = shares_for_usdc(a, 200 * U, B, D).unwrap();
        let gross = sell_value(a + b, a, B, D).unwrap();
        let out = gross - gross / 100;
        assert!(out > a_cost, "expected profit: paid {} got {}", a_cost, out);
    }

    #[test]
    fn reserve_always_covers_selling_everything() {
        let mut supply = 0u64;
        let mut reserve = 0u64;
        let mut holders: Vec<u64> = vec![];
        let budgets = [5 * U, 333 * U, 7_123_456, 499 * U, 12 * U, 5 * U + 3];
        for (i, usdc) in budgets.iter().enumerate() {
            let (n, cost) = shares_for_usdc(supply, *usdc, B, D).unwrap();
            supply += n;
            reserve += cost;
            holders.push(n);
            if i % 2 == 1 {
                let h = holders.remove(0);
                let gross = sell_value(supply, h, B, D).unwrap();
                let out = gross - gross / 100;
                supply -= h;
                reserve -= out;
            }
            assert!(sell_value(supply, supply, B, D).unwrap() <= reserve);
        }
    }

    #[test]
    fn two_outcomes_winners_split_whole_pot_minus_fee() {
        let p = p2(60 * U, 40 * U, 300 * U, 200 * U);
        assert_eq!(fee_for(SIDE_YES, &p, 100).unwrap(), 1 * U);
        assert_eq!(payout_for(100 * U, SIDE_YES, SIDE_YES, &p, 100).unwrap(), 33 * U);
        assert_eq!(payout_for(100 * U, SIDE_NO, SIDE_YES, &p, 100).unwrap(), 0);
    }

    #[test]
    fn three_outcomes_winners_take_both_losing_pools() {
        // A 30, B 50, C 20 USDC. C wins: C holders split 100 minus 1.
        let p = p3([30 * U, 50 * U, 20 * U], [100 * U, 200 * U, 50 * U]);
        assert_eq!(fee_for(3, &p, 100).unwrap(), 1 * U);
        assert_eq!(payout_for(50 * U, 3, 3, &p, 100).unwrap(), 99 * U);
        assert_eq!(payout_for(25 * U, 3, 3, &p, 100).unwrap(), 49_500_000);
        assert_eq!(payout_for(100 * U, 1, 3, &p, 100).unwrap(), 0);
        assert_eq!(payout_for(200 * U, 2, 3, &p, 100).unwrap(), 0);
    }

    #[test]
    fn fee_capped_at_losing_money() {
        let p = p2(1_000 * U, 5 * U, 3_000 * U, 40 * U);
        assert_eq!(fee_for(SIDE_YES, &p, 100).unwrap(), 5 * U);
        assert_eq!(payout_for(3_000 * U, SIDE_YES, SIDE_YES, &p, 100).unwrap(), 1_000 * U);
        let q = p3([1_000 * U, 3 * U, 2 * U], [3_000 * U, 10 * U, 10 * U]);
        assert_eq!(fee_for(1, &q, 100).unwrap(), 5 * U);
    }

    #[test]
    fn nobody_on_winning_outcome_refunds_everyone_their_own_reserve() {
        let p = p2(0, 40 * U, 0, 200 * U);
        assert_eq!(fee_for(SIDE_YES, &p, 100).unwrap(), 0);
        assert_eq!(payout_for(100 * U, SIDE_NO, SIDE_YES, &p, 100).unwrap(), 20 * U);
        // Three outcomes, nobody on B: A and C holders get their own money back, B's leftover is swept.
        let q = p3([30 * U, 2 * U, 20 * U], [100 * U, 0, 50 * U]);
        assert_eq!(fee_for(2, &q, 100).unwrap(), 2 * U);
        assert_eq!(payout_for(50 * U, 1, 2, &q, 100).unwrap(), 15 * U);
        assert_eq!(payout_for(50 * U, 3, 2, &q, 100).unwrap(), 20 * U);
    }

    #[test]
    fn everyone_cashed_out_platform_takes_leftover_fees() {
        let p = p2(300_000, 150_000, 0, 0);
        assert_eq!(fee_for(SIDE_YES, &p, 100).unwrap(), 450_000);
        assert_eq!(payout_for(0, SIDE_YES, SIDE_YES, &p, 100).unwrap(), 0);
    }

    #[test]
    fn void_refund_is_pro_rata_of_own_outcome_and_sweeps_empty_ones() {
        let p = p2(60 * U, 40 * U, 300 * U, 200 * U);
        assert_eq!(refund_for(150 * U, SIDE_YES, &p).unwrap(), 30 * U);
        assert_eq!(refund_for(200 * U, SIDE_NO, &p).unwrap(), 40 * U);
        assert_eq!(orphaned_for(&p).unwrap(), 0);
        let q = p3([300_000, 40 * U, 7 * U], [0, 200 * U, 70 * U]);
        assert_eq!(orphaned_for(&q).unwrap(), 300_000);
        assert_eq!(refund_for(70 * U, 3, &q).unwrap(), 7 * U);
    }

    #[test]
    fn payouts_plus_fee_never_exceed_pot() {
        let holders: [u64; 5] = [123_456_789, 5_000_001, 77 * U, 1, 999_999_999];
        let s: u64 = holders.iter().sum();
        for (p, result) in [
            (p2(777_777_777, 333_333_333, s, 1_000 * U), SIDE_YES),
            (p3([777_777_777, 333_333_333, 111_111_111], [s, 1_000 * U, 500 * U]), 1),
        ] {
            let paid: u64 = holders.iter().map(|h| payout_for(*h, result, result, &p, 100).unwrap()).sum();
            let fee = fee_for(result, &p, 100).unwrap();
            assert!(paid + fee <= p.total().unwrap() as u64);
        }
    }

    #[test]
    fn bonus_in_every_reserve_goes_to_winners_and_keeps_sells_covered() {
        let (ys, cost) = shares_for_usdc(0, 60 * U, B, D).unwrap();
        // 21 USDC bonus over 3 outcomes: 7 each. Only outcome 1 is held.
        let p = p3([cost + 7 * U, 7 * U, 7 * U], [ys, 0, 0]);
        let fee = fee_for(1, &p, 100).unwrap();
        assert_eq!(fee, (cost + 21 * U) / 100);
        assert_eq!(payout_for(ys, 1, 1, &p, 100).unwrap(), cost + 21 * U - fee);
        assert!(sell_value(ys, ys, B, D).unwrap() <= p.reserves[0]);
    }

    #[test]
    fn big_numbers_do_not_overflow() {
        let (n, _) = shares_for_usdc(0, 1_000_000_000 * U, MAX_CURVE_BASE, MAX_CURVE_DEPTH).unwrap();
        assert!(n > 0);
        assert!(sell_value(n, n, MAX_CURVE_BASE, MAX_CURVE_DEPTH).is_some());
        let (n2, _) = shares_for_usdc(0, 1_000_000_000 * U, MIN_CURVE_BASE, MIN_CURVE_DEPTH).unwrap();
        assert!(sell_value(n2, n2, MIN_CURVE_BASE, MIN_CURVE_DEPTH).is_some());
        let big = p3([u64::MAX / 4, u64::MAX / 4, u64::MAX / 4], [1, 1, 1]);
        assert!(payout_for(1, 1, 1, &big, 100).is_some());
    }
}
