use anchor_lang::prelude::*;

use crate::{
    error::RaffleError,
    state::{
        entry::Entry,
        raffle::{Raffle, RaffleState},
    },
};

/// Event emitted when a winner is set for a raffle
#[event]
pub struct WinnerSet {
    /// The pubkey of the raffle
    pub raffle: Pubkey,
    /// The winner's address
    pub winner: Pubkey,
    /// The winning ticket number
    pub winning_ticket: u64,
}

/// Sets the winner of a raffle based on the winning ticket number.
/// This instruction can only be executed when:
/// 1. The raffle is in Drawing state
/// 2. The winning ticket has been drawn
/// 3. The entry PDA matches the winning ticket number
///
/// After execution:
/// - The winner's address is stored in the raffle account
/// - The raffle state is changed to Drawn
pub fn set_winner(ctx: Context<SetWinner>, _entry_seed: [u8; 8]) -> Result<()> {
    // Get the winning ticket number
    let winning_ticket = ctx
        .accounts
        .raffle
        .winning_ticket
        .ok_or(RaffleError::NoWinningTicket)?;

    // Verify the entry contains the winning ticket
    let entry = &ctx.accounts.entry;
    require!(
        winning_ticket >= entry.ticket_start_index
            && winning_ticket
                < entry
                    .ticket_start_index
                    .checked_add(entry.ticket_count)
                    .ok_or(RaffleError::Overflow)?,
        RaffleError::InvalidWinningEntry
    );

    // Set the winner and update state
    ctx.accounts.raffle.winner_address = Some(entry.owner);
    ctx.accounts.raffle.raffle_state = RaffleState::Drawn;

    // Emit winner set event
    emit!(WinnerSet {
        raffle: ctx.accounts.raffle.key(),
        winner: entry.owner,
        winning_ticket,
    });

    Ok(())
}

/// Accounts required for the set_winner instruction
#[derive(Accounts)]
#[instruction(entry_seed: [u8; 8])]
pub struct SetWinner<'info> {
    /// The raffle account to set the winner for.
    /// Must be in Drawing state and have a winning ticket drawn
    #[account(
        mut,
        constraint = raffle.raffle_state == RaffleState::Drawing @ RaffleError::RaffleNotDrawing,
        constraint = raffle.winning_ticket.is_some() @ RaffleError::NoWinningTicket,
    )]
    pub raffle: Account<'info, Raffle>,

    /// The entry account that contains the winning ticket
    /// PDA with empty seeds
    #[account(
        seeds = [
            b"entry",
            raffle.key().as_ref(),
            entry_seed.as_ref()
        ],
        bump,
    )]
    pub entry: Account<'info, Entry>,
}
