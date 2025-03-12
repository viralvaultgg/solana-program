use anchor_lang::prelude::*;

use crate::{
    error::RaffleError,
    state::{Raffle, RaffleState},
};

/// Event emitted when a raffle is expired
#[event]
pub struct RaffleExpired {
    /// The pubkey of the expired raffle
    pub raffle: Pubkey,
    /// The timestamp when the raffle was expired
    pub expired_at: i64,
    /// The final number of tickets sold
    pub final_ticket_count: u64,
}

/// Instruction to expire a raffle that didn't meet the minimum ticket threshold
///
/// # Arguments
/// * `ctx` - The context object containing the raffle account
///
/// # Security Considerations
/// The instruction performs several critical checks:
/// 1. Ensures raffle is in Open state
/// 2. Verifies the raffle's end time has passed
/// 3. Validates that minimum ticket threshold was not met
///
/// # Account Validations
/// * Raffle - Must be in Open state
/// * Raffle - Must be past end time
/// * Raffle - Current tickets must be less than minimum required tickets
///
/// # Implementation Notes
/// - Changes raffle state to Expired
/// - No funds are transferred in this instruction
pub fn expire_raffle(ctx: Context<ExpireRaffle>) -> Result<()> {
    require!(
        ctx.accounts.raffle.raffle_state == RaffleState::Open,
        RaffleError::RaffleNotOpen
    );

    let clock = Clock::get()?;
    require!(
        ctx.accounts.raffle.end_time < clock.unix_timestamp,
        RaffleError::RaffleNotEnded
    );
    require!(
        ctx.accounts.raffle.current_tickets < ctx.accounts.raffle.min_tickets,
        RaffleError::ThresholdIsMet
    );

    ctx.accounts.raffle.raffle_state = RaffleState::Expired;

    // Emit the raffle expired event
    emit!(RaffleExpired {
        raffle: ctx.accounts.raffle.key(),
        expired_at: clock.unix_timestamp,
        final_ticket_count: ctx.accounts.raffle.current_tickets,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExpireRaffle<'info> {
    #[account(mut)]
    pub raffle: Account<'info, Raffle>,
}
