//! MemeMarkets: yes or no prediction markets for Solana memecoins, traded as shares.
//! Each side (Yes, No) has its own price curve: the price rises as people buy that side and falls
//! as they sell. Anyone can sell (cash out) while the market is open. At the end the winning
//! side's shares split the whole pot (both sides' reserves) minus the platform fee.
//! All money is USDC in a per market vault PDA that only this program can move.
//!
//! Lifecycle:
//!   create_market -> (admin) approve_market -> buy_shares / sell_shares ... -> lock -> resolve_market
//!   -> dispute window -> claim (each holder) + collect_fees (anyone)
//!
//! Trust model: the admin key (or a limited resolver key) decides outcomes by reading prices off
//! chain, and the admin approves or rejects markets. Neither can withdraw from a vault. Money only
//! leaves a vault through sell_shares (cash out), claim (payout or refund) and collect_fees.
//! If the admin disappears, anyone can void a stuck market after a delay and everyone is refunded.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("3B84AX7kyaGSMrxyKZrJBng4MQtirx9CF1G54yGGL1RM");

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

pub const SIDE_YES: u8 = 1;
pub const SIDE_NO: u8 = 2;
pub const RESULT_VOID: u8 = 3;

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

/// Price curve for one side: price(x) = base + x / depth, in USDC base units per whole share,
/// where x is that side's share supply in share units.
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

/// Current price of one whole share on a side, in USDC base units.
pub fn spot_price(supply: u64, base: u64, depth: u64) -> u64 {
    base.saturating_add(supply / depth.max(1))
}

/// Pool state a payout depends on.
#[derive(Clone, Copy)]
pub struct Pools {
    pub yes_reserve: u64,
    pub no_reserve: u64,
    pub yes_shares: u64,
    pub no_shares: u64,
}

impl Pools {
    fn side(&self, side: u8) -> (u128, u128) {
        if side == SIDE_YES {
            (self.yes_reserve as u128, self.yes_shares as u128)
        } else {
            (self.no_reserve as u128, self.no_shares as u128)
        }
    }
    fn total(&self) -> Option<u128> {
        (self.yes_reserve as u128).checked_add(self.no_reserve as u128)
    }
}

/// Platform fee for a resolved market: min(total * fee_bps / 10000, losing reserve).
/// Zero when nobody holds the winning side (the other side is refunded the whole pot instead).
/// If nobody holds either side (everyone cashed out), the pot is only retained sell fees and
/// nobody can claim it, so the platform takes all of it.
pub fn fee_for(result: u8, pools: &Pools, fee_bps: u16) -> Option<u64> {
    let lose_side = if result == SIDE_YES { SIDE_NO } else { SIDE_YES };
    let (_, win_shares) = pools.side(result);
    let (lose_reserve, lose_shares) = pools.side(lose_side);
    if win_shares == 0 {
        return if lose_shares == 0 { u64::try_from(pools.total()?).ok() } else { Some(0) };
    }
    let fee = (pools.total()?.checked_mul(fee_bps as u128)? / BPS_DENOM).min(lose_reserve);
    u64::try_from(fee).ok()
}

/// Payout for a position once a market is resolved Yes or No.
/// Winners split the whole pot minus the fee, pro rata by shares. Losers get 0.
/// If nobody holds the winning side, the other side's holders split the whole pot with no fee.
pub fn payout_for(shares: u64, side: u8, result: u8, pools: &Pools, fee_bps: u16) -> Option<u64> {
    let total = pools.total()?;
    let (_, win_shares) = pools.side(result);
    if win_shares == 0 {
        let (_, own_shares) = pools.side(side);
        if own_shares == 0 {
            return Some(0);
        }
        return u64::try_from((shares as u128).checked_mul(total)? / own_shares).ok();
    }
    if side != result {
        return Some(0);
    }
    let pot = total.checked_sub(fee_for(result, pools, fee_bps)? as u128)?;
    u64::try_from((shares as u128).checked_mul(pot)? / win_shares).ok()
}

/// Refund for a void or rejected market: each side's holders split that side's reserve.
pub fn refund_for(shares: u64, side: u8, pools: &Pools) -> Option<u64> {
    let (reserve, supply) = pools.side(side);
    if supply == 0 {
        return Some(0);
    }
    u64::try_from((shares as u128).checked_mul(reserve)? / supply).ok()
}

/// On a void or rejected market, a side whose holders all cashed out still holds its retained sell
/// fees, which no refund can reach. The platform sweeps those through collect_fees.
pub fn orphaned_for(pools: &Pools) -> Option<u64> {
    let mut sum: u128 = 0;
    for side in [SIDE_YES, SIDE_NO] {
        let (reserve, supply) = pools.side(side);
        if supply == 0 {
            sum = sum.checked_add(reserve)?;
        }
    }
    u64::try_from(sum).ok()
}

#[program]
pub mod mememarkets {
    use super::*;

    /// One time setup. Call it in the same breath as the deploy so nobody else initializes first.
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

    /// Kill switch. Pauses new markets and all buying and selling. Claims and refunds always keep working.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// min_bet is the smallest buy, max_bet the most a wallet can have in one market (cost basis).
    /// Limits apply to new trades. Fee and dispute window apply to new markets only: a market keeps the
    /// fee and dispute window it was created with.
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

    /// Anyone can propose a market with a first bet. It waits in Pending until the admin approves.
    #[allow(clippy::too_many_arguments)]
    pub fn create_market(
        ctx: Context<CreateMarket>,
        token_mint: Pubkey,
        metric: u8,
        direction: u8,
        target: u64,
        target_decimals: u8,
        end_ts: i64,
        side: u8,
        seed_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(side == SIDE_YES || side == SIDE_NO, MmError::BadSide);
        require!(seed_amount >= cfg.min_bet && seed_amount <= cfg.max_bet, MmError::BadAmount);
        let m = &mut ctx.accounts.market;
        let params = MarketParams { token_mint, metric, direction, target, target_decimals, end_ts };
        init_market(m, cfg, ctx.accounts.creator.key(), &params, MarketStatus::Pending, ctx.bumps.market, ctx.bumps.vault)?;

        let p = &mut ctx.accounts.position;
        p.market = m.key();
        p.user = ctx.accounts.creator.key();
        p.side = side;
        p.shares = 0;
        p.cost = 0;
        p.claimed = false;
        p.bump = ctx.bumps.position;
        let (shares, paid) = apply_buy(m, p, side, seed_amount, min_shares_out, cfg.max_bet)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.creator_usdc.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            paid,
        )?;
        emit!(MarketCreated { market: m.key(), id: m.id, creator: m.creator, token_mint, end_ts });
        emit_trade(m.key(), m, p.user, side, true, shares, paid);
        Ok(())
    }

    /// Admin only: opens a market straight away (no review) funded by a house seed that takes no side.
    /// The seed goes into the bonus pot exactly like add_bonus: no shares, no position, so the house
    /// wallet never wins or loses it and is not counted as a bettor. Bettors split it on resolution.
    pub fn create_house_market(
        ctx: Context<CreateHouseMarket>,
        token_mint: Pubkey,
        metric: u8,
        direction: u8,
        target: u64,
        target_decimals: u8,
        end_ts: i64,
        seed_amount: u64,
    ) -> Result<()> {
        require!(seed_amount > 0, MmError::BadAmount);
        let cfg = &mut ctx.accounts.config;
        let m = &mut ctx.accounts.market;
        let params = MarketParams { token_mint, metric, direction, target, target_decimals, end_ts };
        init_market(m, cfg, ctx.accounts.admin.key(), &params, MarketStatus::Open, ctx.bumps.market, ctx.bumps.vault)?;
        let yes_part = seed_amount / 2;
        m.yes_reserve = yes_part;
        m.no_reserve = seed_amount - yes_part;
        let b = &mut ctx.accounts.bonus;
        b.market = m.key();
        b.total = seed_amount;
        b.bump = ctx.bumps.bonus;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.admin_usdc.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.admin.to_account_info(),
                },
            ),
            seed_amount,
        )?;
        emit!(MarketCreated { market: m.key(), id: m.id, creator: m.creator, token_mint, end_ts });
        emit!(BonusAdded { market: m.key(), funder: m.creator, amount: seed_amount, total_bonus: seed_amount });
        Ok(())
    }

    pub fn approve_market(ctx: Context<ReviewMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Pending, MmError::BadStatus);
        require!(Clock::get()?.unix_timestamp < m.end_ts, MmError::BadDeadline);
        m.status = MarketStatus::Open;
        Ok(())
    }

    /// Rejected markets refund every position (the creator seed) through claim.
    pub fn reject_market(ctx: Context<ReviewMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Pending, MmError::BadStatus);
        m.status = MarketStatus::Rejected;
        Ok(())
    }

    /// Admin freezes betting the moment the target looks hit, so nobody can bet on a known outcome
    /// while the resolver checks the average. The lock time is kept in resolved_ts while Locked.
    pub fn lock_market(ctx: Context<ResolverAction>) -> Result<()> {
        ctx.accounts.check()?;
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Open, MmError::BadStatus);
        m.status = MarketStatus::Locked;
        m.resolved_ts = Clock::get()?.unix_timestamp;
        emit!(MarketLocked { market: m.key(), locked: true });
        Ok(())
    }

    /// False alarm: reopen betting. Only before the deadline.
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

    /// The creator can pull a market that nobody approved yet. The seed is refunded through claim.
    pub fn cancel_pending(ctx: Context<CancelPending>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Pending, MmError::BadStatus);
        m.status = MarketStatus::Rejected;
        Ok(())
    }

    /// Buy shares of one side with `usdc_in` USDC at the curve price. Reverts if fewer than
    /// `min_shares_out` shares would be received (slippage guard). Only while Open, before the deadline.
    pub fn buy_shares(ctx: Context<Trade>, side: u8, usdc_in: u64, min_shares_out: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, MmError::Paused);
        require!(side == SIDE_YES || side == SIDE_NO, MmError::BadSide);
        require!(usdc_in >= cfg.min_bet, MmError::BadAmount);
        let m = &mut ctx.accounts.market;
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

        let supply = if side == SIDE_YES { m.yes_shares } else { m.no_shares };
        let gross = sell_value(supply, shares, m.curve_base, m.curve_depth).ok_or(MmError::Math)?;
        let fee = u64::try_from((gross as u128) * (m.fee_bps as u128) / BPS_DENOM).map_err(|_| MmError::Math)?;
        let out = gross.checked_sub(fee).ok_or(MmError::Math)?;
        require!(out > 0, MmError::BadAmount);
        require!(out >= min_usdc_out, MmError::Slippage);

        if side == SIDE_YES {
            m.yes_shares = m.yes_shares.checked_sub(shares).ok_or(MmError::Math)?;
            m.yes_reserve = m.yes_reserve.checked_sub(out).ok_or(MmError::Math)?;
        } else {
            m.no_shares = m.no_shares.checked_sub(shares).ok_or(MmError::Math)?;
            m.no_reserve = m.no_reserve.checked_sub(out).ok_or(MmError::Math)?;
        }
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

    /// Admin sets the outcome. result: 1 yes, 2 no, 3 void.
    /// After the deadline: from Open or Locked, any result.
    /// Before the deadline: only Yes (target hit), and only from Locked, so betting is already frozen.
    /// No and Void need the deadline to pass (No means the target was not hit in time).
    /// final_value is the value the admin read off chain, stored for the public resolution record.
    pub fn resolve_market(ctx: Context<ResolverAction>, result: u8, final_value: u64) -> Result<()> {
        ctx.accounts.check()?;
        require!(result == SIDE_YES || result == SIDE_NO || result == RESULT_VOID, MmError::BadParams);
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        let dispute_secs = m.dispute_secs;
        require!(m.status == MarketStatus::Open || m.status == MarketStatus::Locked, MmError::BadStatus);
        let early_yes = m.status == MarketStatus::Locked && result == SIDE_YES;
        require!(now >= m.end_ts || early_yes, MmError::TooEarly);
        m.final_value = final_value;
        m.resolved_ts = now;
        if result == RESULT_VOID {
            m.status = MarketStatus::Void;
        } else {
            m.status = MarketStatus::Resolved;
            m.result = result;
            m.dispute_ends = now.checked_add(dispute_secs).ok_or(MmError::Math)?;
        }
        emit!(MarketResolved { market: m.key(), result, final_value });
        Ok(())
    }

    /// Bonus pot: anyone (normally the platform treasury, funded by creator fees) adds USDC to a
    /// market without taking a side. No shares are minted and no position is created, so the funder
    /// cannot win it back. It is split evenly into the Yes and No reserves, which means the winners
    /// receive all of it on resolution (and on a void each side's holders get their half back).
    /// Only while the market is Pending or Open.
    pub fn add_bonus(ctx: Context<AddBonus>, amount: u64) -> Result<()> {
        require!(amount > 0, MmError::BadAmount);
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Pending || m.status == MarketStatus::Open, MmError::BadStatus);
        let yes_part = amount / 2;
        let no_part = amount - yes_part;
        m.yes_reserve = m.yes_reserve.checked_add(yes_part).ok_or(MmError::Math)?;
        m.no_reserve = m.no_reserve.checked_add(no_part).ok_or(MmError::Math)?;
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

    /// Admin can cancel an open or locked market at any time, for example a rugged token or manipulation.
    /// Everyone is refunded.
    pub fn void_market(ctx: Context<ReviewMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Open || m.status == MarketStatus::Locked, MmError::BadStatus);
        m.status = MarketStatus::Void;
        m.resolved_ts = Clock::get()?.unix_timestamp;
        emit!(MarketResolved { market: m.key(), result: RESULT_VOID, final_value: 0 });
        Ok(())
    }

    /// Any bettor in the market can freeze payouts during the dispute window.
    pub fn dispute_market(ctx: Context<DisputeMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Resolved, MmError::BadStatus);
        require!(!m.disputed, MmError::BadStatus);
        require!(Clock::get()?.unix_timestamp < m.dispute_ends, MmError::DisputeClosed);
        m.disputed = true;
        emit!(MarketDisputed { market: m.key(), by: ctx.accounts.user.key() });
        Ok(())
    }

    /// Admin decides a dispute: 1 yes, 2 no, 3 void. Payouts open right away after.
    pub fn settle_dispute(ctx: Context<ResolveMarket>, result: u8) -> Result<()> {
        require!(result == SIDE_YES || result == SIDE_NO || result == RESULT_VOID, MmError::BadParams);
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
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

    /// Safety valve. If the admin never resolves (open or locked), or never settles a dispute, anyone can void the market
    /// after a delay. Everyone is then refunded in full.
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

    /// Pays a winner, or refunds a stake on a void, rejected or one sided market. Pays the signer's own wallet only.
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

    /// Sends the platform fee to the fee vault. Anyone can call it, once per market: on a resolved
    /// market after the dispute window, or on a void or rejected market (sweeps retained sell fees
    /// from sides nobody holds any more, since no refund can reach them).
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
        m.fee_collected = true;
        if fee > 0 {
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
                fee,
            )?;
        }
        Ok(())
    }
}

pub struct MarketParams {
    pub token_mint: Pubkey,
    pub metric: u8,
    pub direction: u8,
    pub target: u64,
    pub target_decimals: u8,
    pub end_ts: i64,
}

/// Shared by create_market and create_house_market: checks the market terms, fills in a fresh
/// market with empty pools and bumps the market count.
fn init_market(m: &mut Market, cfg: &mut Config, creator: Pubkey, p: &MarketParams, status: MarketStatus, bump: u8, vault_bump: u8) -> Result<()> {
    require!(!cfg.paused, MmError::Paused);
    require!(p.metric == METRIC_MCAP || p.metric == METRIC_PRICE, MmError::BadParams);
    require!(p.direction == DIR_ABOVE || p.direction == DIR_BELOW, MmError::BadParams);
    require!(p.target > 0 && p.target_decimals <= 18, MmError::BadParams);
    let now = Clock::get()?.unix_timestamp;
    require!(p.end_ts >= now + MIN_DURATION && p.end_ts <= now + MAX_DURATION, MmError::BadDeadline);
    m.id = cfg.market_count;
    m.creator = creator;
    m.token_mint = p.token_mint;
    m.metric = p.metric;
    m.direction = p.direction;
    m.target = p.target;
    m.target_decimals = p.target_decimals;
    m.end_ts = p.end_ts;
    m.created_ts = now;
    m.status = status;
    m.result = 0;
    m.yes_reserve = 0;
    m.no_reserve = 0;
    m.yes_shares = 0;
    m.no_shares = 0;
    m.curve_base = cfg.curve_base;
    m.curve_depth = cfg.curve_depth;
    m.fee_bps = cfg.fee_bps;
    m.dispute_secs = cfg.dispute_secs;
    m.resolved_ts = 0;
    m.dispute_ends = 0;
    m.disputed = false;
    m.fee_collected = false;
    m.final_value = 0;
    m.bump = bump;
    m.vault_bump = vault_bump;
    cfg.market_count = cfg.market_count.checked_add(1).ok_or(MmError::Math)?;
    Ok(())
}

/// Shared by create_market and buy_shares: prices the buy, updates market and position, returns
/// (shares bought, USDC to transfer in).
fn apply_buy(m: &mut Market, p: &mut Position, side: u8, usdc_in: u64, min_shares_out: u64, max_bet: u64) -> Result<(u64, u64)> {
    if p.shares == 0 {
        p.side = side; // an empty position may switch sides
    }
    require!(p.side == side, MmError::OtherSide);
    let supply = if side == SIDE_YES { m.yes_shares } else { m.no_shares };
    let (shares, paid) = shares_for_usdc(supply, usdc_in, m.curve_base, m.curve_depth).ok_or(MmError::Math)?;
    require!(shares > 0, MmError::BadAmount);
    require!(shares >= min_shares_out, MmError::Slippage);
    let new_cost = p.cost.checked_add(paid).ok_or(MmError::Math)?;
    require!(new_cost <= max_bet, MmError::OverMax);
    p.cost = new_cost;
    p.shares = p.shares.checked_add(shares).ok_or(MmError::Math)?;
    if side == SIDE_YES {
        m.yes_shares = m.yes_shares.checked_add(shares).ok_or(MmError::Math)?;
        m.yes_reserve = m.yes_reserve.checked_add(paid).ok_or(MmError::Math)?;
    } else {
        m.no_shares = m.no_shares.checked_add(shares).ok_or(MmError::Math)?;
        m.no_reserve = m.no_reserve.checked_add(paid).ok_or(MmError::Math)?;
    }
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
    emit!(Traded {
        market,
        user,
        side,
        buy,
        shares,
        usdc,
        yes_reserve: m.yes_reserve,
        no_reserve: m.no_reserve,
        yes_shares: m.yes_shares,
        no_shares: m.no_shares,
        yes_price: spot_price(m.yes_shares, m.curve_base, m.curve_depth),
        no_price: spot_price(m.no_shares, m.curve_base, m.curve_depth),
    });
}

impl Market {
    pub fn pools(&self) -> Pools {
        Pools { yes_reserve: self.yes_reserve, no_reserve: self.no_reserve, yes_shares: self.yes_shares, no_shares: self.no_shares }
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
}

/// Running total of bonus USDC added to one market, PDA ["bonus", market]. Informational: payouts
/// already include the bonus through the reserves. Lets the app show the bonus and exclude it from odds.
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
    /// Trading frozen while the resolver checks a target hit.
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
    pub result: u8,
    /// USDC held for each side: bought in minus sold out, plus sell fees kept in the pot.
    pub yes_reserve: u64,
    pub no_reserve: u64,
    /// Share supply per side (share units, 1_000_000 per share).
    pub yes_shares: u64,
    pub no_shares: u64,
    /// Price curve copied from config at creation.
    pub curve_base: u64,
    pub curve_depth: u64,
    pub fee_bps: u16,
    /// Dispute window copied from config at creation.
    pub dispute_secs: i64,
    /// Time of the last lock, resolve or void. Holds the lock time while Locked.
    pub resolved_ts: i64,
    pub dispute_ends: i64,
    pub disputed: bool,
    pub fee_collected: bool,
    pub final_value: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub user: Pubkey,
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
        init, payer = creator, space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), creator.key().as_ref()], bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = usdc_mint, token::authority = creator)]
    pub creator_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateHouseMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ MmError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init, payer = admin, space = 8 + Market::INIT_SPACE,
        seeds = [b"market", config.market_count.to_le_bytes().as_ref()], bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init, payer = admin,
        seeds = [b"vault", market.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = market
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = admin, space = 8 + MarketBonus::INIT_SPACE,
        seeds = [b"bonus", market.key().as_ref()], bump
    )]
    pub bonus: Account<'info, MarketBonus>,
    #[account(mut, token::mint = usdc_mint, token::authority = admin)]
    pub admin_usdc: Account<'info, TokenAccount>,
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

#[derive(Accounts)]
pub struct CancelPending<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump,
        has_one = creator @ MmError::Unauthorized
    )]
    pub market: Account<'info, Market>,
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

// ───────────────────────────── events and errors ─────────────────────────────

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub id: u64,
    pub creator: Pubkey,
    pub token_mint: Pubkey,
    pub end_ts: i64,
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
    pub yes_reserve: u64,
    pub no_reserve: u64,
    pub yes_shares: u64,
    pub no_shares: u64,
    /// Spot price after the trade, USDC base units per whole share
    pub yes_price: u64,
    pub no_price: u64,
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
    #[msg("Side must be 1 (yes) or 2 (no)")]
    BadSide,
    #[msg("Amount is outside the allowed range")]
    BadAmount,
    #[msg("Deadline must be 1 hour to 90 days away")]
    BadDeadline,
    #[msg("Market is not in the right status")]
    BadStatus,
    #[msg("Trading is closed for this market")]
    BettingClosed,
    #[msg("You hold shares on the other side of this market. Sell them first")]
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
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: u64 = 1_000_000; // 1 USDC, also 1 share
    const B: u64 = DEFAULT_CURVE_BASE;
    const D: u64 = DEFAULT_CURVE_DEPTH;

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
                // one more share unit would cost more than the budget
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
        // early buyer sells first, at the higher price
        let gross = sell_value(a + b, a, B, D).unwrap();
        let out = gross - gross / 100; // 1 percent sell fee
        assert!(out > a_cost, "expected profit: paid {} got {}", a_cost, out);
    }

    #[test]
    fn reserve_always_covers_selling_everything() {
        // Random-ish sequence of buys and sells; at every step the reserve covers selling the whole supply.
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

    fn pools(yr: u64, nr: u64, ys: u64, ns: u64) -> Pools {
        Pools { yes_reserve: yr, no_reserve: nr, yes_shares: ys, no_shares: ns }
    }

    #[test]
    fn winners_split_whole_pot_minus_fee() {
        let p = pools(60 * U, 40 * U, 300 * U, 200 * U);
        assert_eq!(fee_for(SIDE_YES, &p, 100).unwrap(), 1 * U);
        // 100 shares of 300 Yes shares: 1/3 of 99
        assert_eq!(payout_for(100 * U, SIDE_YES, SIDE_YES, &p, 100).unwrap(), 33 * U);
        assert_eq!(payout_for(100 * U, SIDE_NO, SIDE_YES, &p, 100).unwrap(), 0);
    }

    #[test]
    fn fee_capped_at_losing_reserve() {
        let p = pools(1_000 * U, 5 * U, 3_000 * U, 40 * U);
        assert_eq!(fee_for(SIDE_YES, &p, 100).unwrap(), 5 * U);
        assert_eq!(payout_for(3_000 * U, SIDE_YES, SIDE_YES, &p, 100).unwrap(), 1_000 * U);
    }

    #[test]
    fn nobody_on_winning_side_refunds_other_side_whole_pot() {
        let p = pools(0, 40 * U, 0, 200 * U);
        assert_eq!(fee_for(SIDE_YES, &p, 100).unwrap(), 0);
        assert_eq!(payout_for(100 * U, SIDE_NO, SIDE_YES, &p, 100).unwrap(), 20 * U);
    }

    #[test]
    fn void_refund_is_pro_rata_of_own_side() {
        let p = pools(60 * U, 40 * U, 300 * U, 200 * U);
        assert_eq!(refund_for(150 * U, SIDE_YES, &p).unwrap(), 30 * U);
        assert_eq!(refund_for(200 * U, SIDE_NO, &p).unwrap(), 40 * U);
    }

    #[test]
    fn payouts_plus_fee_never_exceed_pot() {
        let holders: [u64; 5] = [123_456_789, 5_000_001, 77 * U, 1, 999_999_999];
        let ys: u64 = holders.iter().sum();
        let p = pools(777_777_777, 333_333_333, ys, 1_000 * U);
        let paid: u64 = holders.iter().map(|h| payout_for(*h, SIDE_YES, SIDE_YES, &p, 100).unwrap()).sum();
        let fee = fee_for(SIDE_YES, &p, 100).unwrap();
        assert!(paid + fee <= p.yes_reserve + p.no_reserve);
    }

    #[test]
    fn everyone_cashed_out_platform_takes_leftover_fees() {
        // Both sides sold out before the deadline: only retained sell fees remain, nobody can claim them.
        let p = pools(300_000, 150_000, 0, 0);
        assert_eq!(fee_for(SIDE_YES, &p, 100).unwrap(), 450_000);
        assert_eq!(payout_for(0, SIDE_YES, SIDE_YES, &p, 100).unwrap(), 0);
        assert_eq!(payout_for(0, SIDE_NO, SIDE_YES, &p, 100).unwrap(), 0);
    }

    #[test]
    fn void_sweeps_only_sides_nobody_holds() {
        let p = pools(300_000, 40 * U, 0, 200 * U);
        assert_eq!(orphaned_for(&p).unwrap(), 300_000);
        assert_eq!(refund_for(200 * U, SIDE_NO, &p).unwrap(), 40 * U);
        assert_eq!(refund_for(5, SIDE_YES, &p).unwrap(), 0);
        let q = pools(60 * U, 40 * U, 300 * U, 200 * U);
        assert_eq!(orphaned_for(&q).unwrap(), 0);
    }

    #[test]
    fn bonus_in_both_reserves_goes_to_winners_and_keeps_sells_covered() {
        // Yes holders 300 shares bought for 60, nobody on No, then a 20 USDC bonus split 10/10.
        let (ys, cost) = shares_for_usdc(0, 60 * U, B, D).unwrap();
        let p = pools(cost + 10 * U, 10 * U, ys, 0);
        // Yes wins: Yes holders take everything including the whole bonus, minus the usual 1% fee.
        let fee = fee_for(SIDE_YES, &p, 100).unwrap();
        assert_eq!(fee, (cost + 20 * U) / 100);
        assert_eq!(payout_for(ys, SIDE_YES, SIDE_YES, &p, 100).unwrap(), cost + 20 * U - fee);
        // A late No buyer of 5 USDC who wins takes the Yes money plus the whole bonus.
        let (ns, ncost) = shares_for_usdc(0, 5 * U, B, D).unwrap();
        let q = pools(cost + 10 * U, 10 * U + ncost, ys, ns);
        let win = payout_for(ns, SIDE_NO, SIDE_NO, &q, 100).unwrap();
        assert!(win > ncost + cost, "No winner gets the Yes money and the bonus");
        // The extra reserve never weakens solvency: selling every share is still covered.
        assert!(sell_value(ys, ys, B, D).unwrap() <= q.yes_reserve);
        assert!(sell_value(ns, ns, B, D).unwrap() <= q.no_reserve);
    }

    #[test]
    fn big_numbers_do_not_overflow() {
        let (n, _) = shares_for_usdc(0, 1_000_000_000 * U, MAX_CURVE_BASE, MAX_CURVE_DEPTH).unwrap();
        assert!(n > 0);
        assert!(sell_value(n, n, MAX_CURVE_BASE, MAX_CURVE_DEPTH).is_some());
        let (n2, _) = shares_for_usdc(0, 1_000_000_000 * U, MIN_CURVE_BASE, MIN_CURVE_DEPTH).unwrap();
        assert!(sell_value(n2, n2, MIN_CURVE_BASE, MIN_CURVE_DEPTH).is_some());
    }
}
