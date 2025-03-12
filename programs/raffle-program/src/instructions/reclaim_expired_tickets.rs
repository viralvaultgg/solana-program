use anchor_lang::prelude::*;

use crate::{error::RaffleError, state::{Raffle, RaffleState, TicketBalance, Treasury}};

/// Instruction to reclaim funds from tickets purchased in an expired raffle
///
/// # Security Considerations
/// The instruction performs several critical checks:
/// 1. Validates the raffle is in Expired state
/// 2. Ensures signer is the owner of the ticket balance
/// 3. Verifies the treasury account matches the one stored in raffle
/// 4. Confirms the ticket balance is greater than 0
///
/// # Account Validations
/// * Raffle - Must be in Expired state
/// * Signer - Must match the owner of the ticket balance
/// * TicketBalance - PDA storing ticket purchase info, closed after refund
/// * Treasury - Must match raffle's treasury and use proper PDA seeds
///
/// # Implementation Notes
/// - Refunds the full ticket price for all tickets owned
/// - Closes the ticket balance account and reclaims rent
/// - Funds transfer happens directly between PDAs
pub fn reclaim_expired_tickets(ctx: Context<ReclaimExpiredTickets>) -> Result<()> {
    require!(
        ctx.accounts.raffle.raffle_state == RaffleState::Expired, 
        RaffleError::RaffleNotExpired
    );
    require!(
        ctx.accounts.signer.key() == ctx.accounts.ticket_balance.owner,
        RaffleError::OwnerMismatch
    );
    require!(
        ctx.accounts.raffle.treasury.key() == ctx.accounts.treasury.key(),
        RaffleError::InvalidTreasury
    );
    require!(
        ctx.accounts.ticket_balance.ticket_count > 0,
        RaffleError::NoTicketsOwned
    );

    let from_pubkey = ctx.accounts.treasury.to_account_info();
    let to_pubkey = ctx.accounts.signer.to_account_info();

    // Transfer lamports by directly deducting from treasury and adding to signer. 
    // This only works because the treasury is a PDA owned by our program.
    let total_lamports_to_transfer = ctx.accounts.ticket_balance.ticket_count * ctx.accounts.raffle.ticket_price;
    from_pubkey.sub_lamports(total_lamports_to_transfer)?;
    to_pubkey.add_lamports(total_lamports_to_transfer)?;

    Ok(())
}

#[derive(Accounts)]
pub struct ReclaimExpiredTickets<'info> {
    /// The user reclaiming their tickets
    #[account(mut)]
    pub signer: Signer<'info>,

    /// Ticket balance PDA for this user in this raffle
    /// Account is closed and rent is reclaimed
    #[account(
        mut, 
        close = signer,
        seeds = [
            b"ticket_balance",
            raffle.key().as_ref(),
            signer.key().as_ref()
        ], 
        bump = ticket_balance.bump
    )]
    pub ticket_balance: Account<'info, TicketBalance>,

    /// The raffle account that must be in Expired state
    pub raffle: Account<'info, Raffle>,
    
    /// Required by Anchor for transfers
    pub system_program: Program<'info, System>,

    /// Treasury PDA for this raffle that holds the funds
    #[account(
        mut,
        seeds = [
            b"treasury",
            raffle.key().as_ref(),
        ],
        bump = treasury.bump,
    )]
    pub treasury: Account<'info, Treasury>,
}
