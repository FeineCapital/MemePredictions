//! MemeMarkets: yes or no parimutuel prediction markets for Solana memecoins.
//! All bets are in USDC (SPL token). Funds sit in a per market vault PDA that
//! only this program can move. There is no private key that can take the funds.
//!
//! Lifecycle:
//!   create_market -> (admin) approve_market -> place_bet ... -> (admin) resolve_market
//!   -> dispute window -> claim (each bettor) + collect_fees (anyone)
//!
//! Trust model: the admin key decides outcomes (it reads DexScreener/Birdeye off chain)
//! and approves or rejects markets. The admin can never withdraw bets. Funds can only go
//! to bettors (claim) or to the fee vault (1 percent, only on markets with real winners).
//! If the admin disappears, anyone can void a stuck market after a delay and everyone is refunded.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("EaYBtMWdemH7szKjdtiti6iLgRi6HDTdqpsyk7qDwh49");

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

/// Fee for a two sided market: fee_bps of the total pool, capped at the losing pool so a winner
/// always gets at least their stake back.
fn capped_fee(total: u128, lose: u128, fee_bps: u16) -> Option<u128> {
    Some((total.checked_mul(fee_bps as u128)? / BPS_DENOM).min(lose))
}

/// Payout for one position once a market is resolved Yes or No.
/// Refund (full stake, no fee) when either side has no money.
/// Winners get stake + stake / winning pool * (losing pool - fee). Losers get 0.
pub fn payout_for(stake: u64, side: u8, result: u8, yes_pool: u64, no_pool: u64, fee_bps: u16) -> Option<u64> {
    let total = (yes_pool as u128).checked_add(no_pool as u128)?;
    let (win, lose) = if result == SIDE_YES {
        (yes_pool as u128, no_pool as u128)
    } else {
        (no_pool as u128, yes_pool as u128)
    };
    if win == 0 || lose == 0 {
        return Some(stake);
    }
    if side != result {
        return Some(0);
    }
    let fee = capped_fee(total, lose, fee_bps)?;
    let bonus = (stake as u128).checked_mul(lose.checked_sub(fee)?)? / win;
    u64::try_from((stake as u128).checked_add(bonus)?).ok()
}

/// Fee owed to the platform for a resolved market: min(total * fee_bps / 10000, losing pool).
/// Zero when it is a refund market.
pub fn fee_for(result: u8, yes_pool: u64, no_pool: u64, fee_bps: u16) -> Option<u64> {
    let total = (yes_pool as u128).checked_add(no_pool as u128)?;
    let (win, lose) = if result == SIDE_YES {
        (yes_pool as u128, no_pool as u128)
    } else {
        (no_pool as u128, yes_pool as u128)
    };
    if win == 0 || lose == 0 {
        return Some(0);
    }
    u64::try_from(capped_fee(total, lose, fee_bps)?).ok()
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

    /// Kill switch. Pauses new bets and new markets. Claims and refunds always keep working.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Limits apply to new bets. Fee and dispute window apply to new markets only: a market keeps the
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
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(!cfg.paused, MmError::Paused);
        require!(metric == METRIC_MCAP || metric == METRIC_PRICE, MmError::BadParams);
        require!(direction == DIR_ABOVE || direction == DIR_BELOW, MmError::BadParams);
        require!(target > 0 && target_decimals <= 18, MmError::BadParams);
        require!(side == SIDE_YES || side == SIDE_NO, MmError::BadSide);
        require!(seed_amount >= cfg.min_bet && seed_amount <= cfg.max_bet, MmError::BadAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(end_ts >= now + MIN_DURATION && end_ts <= now + MAX_DURATION, MmError::BadDeadline);

        let m = &mut ctx.accounts.market;
        m.id = cfg.market_count;
        m.creator = ctx.accounts.creator.key();
        m.token_mint = token_mint;
        m.metric = metric;
        m.direction = direction;
        m.target = target;
        m.target_decimals = target_decimals;
        m.end_ts = end_ts;
        m.created_ts = now;
        m.status = MarketStatus::Pending;
        m.result = 0;
        m.yes_pool = if side == SIDE_YES { seed_amount } else { 0 };
        m.no_pool = if side == SIDE_NO { seed_amount } else { 0 };
        m.fee_bps = cfg.fee_bps;
        m.dispute_secs = cfg.dispute_secs;
        m.resolved_ts = 0;
        m.dispute_ends = 0;
        m.disputed = false;
        m.fee_collected = false;
        m.final_value = 0;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.vault;
        cfg.market_count = cfg.market_count.checked_add(1).ok_or(MmError::Math)?;

        let p = &mut ctx.accounts.position;
        p.market = m.key();
        p.user = ctx.accounts.creator.key();
        p.side = side;
        p.amount = seed_amount;
        p.claimed = false;
        p.bump = ctx.bumps.position;

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
        emit!(MarketCreated { market: m.key(), id: m.id, creator: m.creator, token_mint, end_ts });
        emit!(BetPlaced { market: m.key(), user: p.user, side, amount: seed_amount, yes_pool: m.yes_pool, no_pool: m.no_pool });
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

    pub fn place_bet(ctx: Context<PlaceBet>, side: u8, amount: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, MmError::Paused);
        require!(side == SIDE_YES || side == SIDE_NO, MmError::BadSide);
        require!(amount >= cfg.min_bet, MmError::BadAmount);
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Open, MmError::BadStatus);
        require!(Clock::get()?.unix_timestamp < m.end_ts, MmError::BettingClosed);

        let p = &mut ctx.accounts.position;
        if p.user == Pubkey::default() {
            p.market = m.key();
            p.user = ctx.accounts.user.key();
            p.side = side;
            p.amount = 0;
            p.claimed = false;
            p.bump = ctx.bumps.position;
        } else {
            require!(p.side == side, MmError::OtherSide);
        }
        let new_total = p.amount.checked_add(amount).ok_or(MmError::Math)?;
        require!(new_total <= cfg.max_bet, MmError::OverMax);
        p.amount = new_total;
        if side == SIDE_YES {
            m.yes_pool = m.yes_pool.checked_add(amount).ok_or(MmError::Math)?;
        } else {
            m.no_pool = m.no_pool.checked_add(amount).ok_or(MmError::Math)?;
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(BetPlaced { market: m.key(), user: p.user, side, amount, yes_pool: m.yes_pool, no_pool: m.no_pool });
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
        let now = Clock::get()?.unix_timestamp;
        let m = &ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        require!(!p.claimed, MmError::AlreadyClaimed);
        let payout = match m.status {
            MarketStatus::Void | MarketStatus::Rejected => p.amount,
            MarketStatus::Resolved => {
                require!(!m.disputed && now >= m.dispute_ends, MmError::NotClaimable);
                payout_for(p.amount, p.side, m.result, m.yes_pool, m.no_pool, m.fee_bps).ok_or(MmError::Math)?
            }
            _ => return err!(MmError::NotClaimable),
        };
        p.claimed = true;
        if payout > 0 {
            let id = m.id.to_le_bytes();
            let bump = [m.bump];
            let seeds: &[&[&[u8]]] = &[&[b"market", id.as_ref(), bump.as_ref()]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.user_usdc.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    seeds,
                ),
                payout,
            )?;
        }
        emit!(Claimed { market: ctx.accounts.market.key(), user: ctx.accounts.user.key(), amount: payout });
        Ok(())
    }

    /// Sends the platform fee to the fee vault. Anyone can call it, once per market, after the dispute window.
    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Resolved, MmError::BadStatus);
        require!(!m.disputed && now >= m.dispute_ends, MmError::NotClaimable);
        require!(!m.fee_collected, MmError::AlreadyClaimed);
        let fee = fee_for(m.result, m.yes_pool, m.no_pool, m.fee_bps).ok_or(MmError::Math)?;
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
}

/// Separate from Config so existing deployments keep their Config layout.
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
    /// Betting frozen while the resolver checks a target hit. Added last so existing accounts keep their values.
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
    pub yes_pool: u64,
    pub no_pool: u64,
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
    pub amount: u64,
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
pub struct PlaceBet<'info> {
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
pub struct DisputeMarket<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()], bump = position.bump,
        constraint = position.amount > 0 @ MmError::Unauthorized
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
pub struct BetPlaced {
    pub market: Pubkey,
    pub user: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub yes_pool: u64,
    pub no_pool: u64,
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
    #[msg("New bets and markets are paused")]
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
    #[msg("Betting is closed")]
    BettingClosed,
    #[msg("You already bet on the other side of this market")]
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
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: u64 = 1_000_000; // 1 USDC

    #[test]
    fn winner_gets_share_of_pool_minus_fee() {
        // Yes 60, No 40, you have 6 on Yes, Yes wins: 6/60*100*0.99 = 9.9
        let p = payout_for(6 * U, SIDE_YES, SIDE_YES, 60 * U, 40 * U, 100).unwrap();
        assert_eq!(p, 9_900_000);
    }

    #[test]
    fn loser_gets_zero() {
        assert_eq!(payout_for(10 * U, SIDE_NO, SIDE_YES, 60 * U, 40 * U, 100).unwrap(), 0);
    }

    #[test]
    fn empty_losing_side_refunds_in_full() {
        assert_eq!(payout_for(10 * U, SIDE_YES, SIDE_YES, 50 * U, 0, 100).unwrap(), 10 * U);
        assert_eq!(fee_for(SIDE_YES, 50 * U, 0, 100).unwrap(), 0);
    }

    #[test]
    fn empty_winning_side_refunds_everyone() {
        // Yes wins but nobody is on Yes: the No bettors get their stake back.
        assert_eq!(payout_for(10 * U, SIDE_NO, SIDE_YES, 0, 40 * U, 100).unwrap(), 10 * U);
    }

    #[test]
    fn fee_is_one_percent_of_total_pool() {
        assert_eq!(fee_for(SIDE_YES, 60 * U, 40 * U, 100).unwrap(), 1 * U);
    }

    #[test]
    fn vault_never_pays_out_more_than_it_holds() {
        // Many uneven stakes: payouts plus fee must never exceed the pool.
        let stakes: [u64; 7] = [5_000_001, 7_333_333, 100_000_000, 499_999_999, 5_000_000, 13_131_313, 250_000_007];
        let yes: u64 = stakes.iter().sum();
        let no: u64 = 337_777_777;
        let paid: u64 = stakes.iter().map(|s| payout_for(*s, SIDE_YES, SIDE_YES, yes, no, 100).unwrap()).sum();
        let fee = fee_for(SIDE_YES, yes, no, 100).unwrap();
        assert!(paid + fee <= yes + no, "paid {} fee {} total {}", paid, fee, yes + no);
    }

    #[test]
    fn lopsided_pool_winners_never_get_less_than_stake() {
        // Losing pool under 1 percent of the winning pool: fee is capped at the losing pool.
        let stakes: [u64; 3] = [500 * U, 495 * U, 7_777_777];
        let yes: u64 = stakes.iter().sum();
        let no: u64 = 5 * U;
        let fee = fee_for(SIDE_YES, yes, no, 100).unwrap();
        assert_eq!(fee, no);
        let mut paid = 0u64;
        for s in stakes {
            let p = payout_for(s, SIDE_YES, SIDE_YES, yes, no, 100).unwrap();
            assert!(p >= s, "winner got {} for stake {}", p, s);
            paid += p;
        }
        assert!(paid + fee <= yes + no);
        // Slightly above the cap: winners share what is left after the fee.
        let no2: u64 = 12 * U; // fee = 10.12 USDC of a 1012 USDC pool
        let p = payout_for(500 * U, SIDE_YES, SIDE_YES, 1000 * U, no2, 100).unwrap();
        assert_eq!(p, 500 * U + 940_000);
        assert_eq!(fee_for(SIDE_YES, 1000 * U, no2, 100).unwrap(), 10_120_000);
    }

    #[test]
    fn very_large_pools_do_not_overflow() {
        // 10 billion USDC on each side, far beyond anything USDC supply allows in one market.
        let big = 10_000_000_000u64 * U;
        assert!(payout_for(big, SIDE_YES, SIDE_YES, big, big, 100).is_some());
    }
}
