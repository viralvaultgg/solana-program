use anchor_lang::prelude::*;

use crate::{
    error::RaffleError,
    state::{Raffle, RaffleState, TicketBalance, TICKET_BALANCE_ACCOUNT_SIZE},
};

/// Initializes a new ticket balance account for a user in a specific raffle.
/// This account tracks how many tickets a user owns in a particular raffle.
/// The account is PDA-derived using ["ticket_balance", raffle_pubkey, user_pubkey].
///
/// # Events
/// None
///
/// # Account Structure
/// - `signer` (Signer): The user who will own the ticket balance account
/// - `ticket_balance` (PDA): The account to store the user's ticket balance
///   - Seeds: ["ticket_balance", raffle.key(), signer.key()]
///   - Space: 8 (discriminator) + 32 (owner) + 8 (ticket_count) + 1 (bump) = 49 bytes
/// - `raffle` (Account): The raffle account this ticket balance is associated with
/// - `system_program`: Required for account creation
///
/// # State Changes
/// - Creates a new `TicketBalance` account
/// - Initializes owner to signer's pubkey
/// - Sets initial ticket_count to 0
/// - Stores the PDA bump
///
/// # Access Control
/// - Anyone can initialize their own ticket balance account
/// - One ticket balance account per user per raffle
///
/// # Lifecycle
/// - Account is created when user wants to participate in a raffle
/// - Account is automatically closed when expired tickets are reclaimed
pub fn init_ticket_balance(ctx: Context<InitTicketBalance>) -> Result<()> {
    // Verify raffle is in active state
    require!(
        ctx.accounts.raffle.raffle_state == RaffleState::Open,
        RaffleError::RaffleNotOpen
    );

    let ticket_balance = &mut ctx.accounts.ticket_balance;
    ticket_balance.owner = ctx.accounts.signer.key();
    ticket_balance.ticket_count = 0;
    ticket_balance.bump = ctx.bumps.ticket_balance;

    Ok(())
}

#[derive(Accounts)]
pub struct InitTicketBalance<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = TICKET_BALANCE_ACCOUNT_SIZE,
        seeds = [
            b"ticket_balance",
            raffle.key().as_ref(),
            signer.key().as_ref(),
        ],
        bump,
    )]
    pub ticket_balance: Account<'info, TicketBalance>,

    pub raffle: Account<'info, Raffle>,
    pub system_program: Program<'info, System>,
}
