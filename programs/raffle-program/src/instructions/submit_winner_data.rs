use anchor_lang::prelude::*;

use crate::{
    error::RaffleError,
    state::{raffle::*, WinnerData, WINNER_DATA_ACCOUNT_SIZE},
};

/// Event emitted when a winner submits their encrypted data
#[event]
pub struct WinnerDataSubmitted {
    /// The pubkey of the raffle
    pub raffle: Pubkey,
}

/// Instruction for a raffle winner to submit their encrypted contact information
///
/// # Security Considerations
/// The instruction performs several critical checks:
/// 1. Validates the raffle is in Drawn state
/// 2. Ensures signer is the designated winner of the raffle
/// 3. Verifies the data length is <= 854 characters
/// 4. Uses PDAs with proper seeds for secure storage
///
/// # Account Validations
/// * Raffle - Must be in Drawn state
/// * Signer - Must be the designated winner stored in the raffle account
/// * WinnerData - New PDA initialized to store the winner's encrypted contact information
///
/// # Implementation Notes
/// - Creates a new WinnerData account with encrypted contact information
/// - Updates raffle state from Drawn to Claimed
/// - Uses encryption to protect winner's personal information on-chain
/// - Emits WinnerDataSubmitted event to notify off-chain systems
pub fn submit_winner_data(ctx: Context<SubmitWinnerData>, data: String) -> Result<()> {
    require!(data.len() <= 854, RaffleError::InvalidDataLength);
    require!(data.len() > 0, RaffleError::InvalidDataLength);

    // Store the encrypted username
    ctx.accounts.winner_data.data = data;

    // Update raffle state to Claimed
    ctx.accounts.raffle.raffle_state = RaffleState::Claimed;

    // Emit event
    emit!(WinnerDataSubmitted {
        raffle: ctx.accounts.raffle.key()
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SubmitWinnerData<'info> {
    /// The raffle account that must be in Drawn state
    /// Must have the signer as the designated winner
    #[account(
        mut,
        constraint = raffle.raffle_state == RaffleState::Drawn @ RaffleError::RaffleNotDrawn,
        constraint = signer.key() == raffle.winner_address.unwrap() @ RaffleError::NotWinner,
    )]
    pub raffle: Account<'info, Raffle>,

    /// New PDA to store winner's encrypted contact information
    #[account(
        init,
        payer = signer,
        space = WINNER_DATA_ACCOUNT_SIZE,
        seeds = [
            b"winner_data",
            raffle.key().as_ref(),
            signer.key().as_ref(),
        ],
        bump
    )]
    pub winner_data: Account<'info, WinnerData>,

    /// The winner submitting their contact information
    /// Must match the winner_address stored in the raffle account
    #[account(mut)]
    pub signer: Signer<'info>,

    /// Required by Anchor for account creation
    pub system_program: Program<'info, System>,
}
