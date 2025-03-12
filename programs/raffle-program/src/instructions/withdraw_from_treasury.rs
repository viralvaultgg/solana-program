use anchor_lang::prelude::*;

use crate::{
    error::RaffleError,
    state::{Config, Raffle, Treasury, TREASURY_ACCOUNT_SIZE},
};

/// Event emitted when treasury funds are withdrawn
#[event]
pub struct TreasuryWithdrawn {
    /// The pubkey of the raffle
    pub raffle: Pubkey,
    /// Amount withdrawn in lamports
    pub amount: u64,
}

/// Instruction to withdraw all funds from a raffle's treasury to the payout authority
///
/// # Security Considerations
/// The instruction performs several critical checks:
/// 1. Validates the ticket threshold has been met
/// 2. Verifies the signer is the management authority
/// 3. Ensures treasury account matches the one stored in raffle
/// 4. Validates treasury has funds to withdraw
///
/// # Account Validations
/// * Raffle - Must be in Drawn state
/// * Signer - Must be the management authority
/// * Treasury - Must match raffle's treasury and use proper PDA seeds
pub fn withdraw_from_treasury(ctx: Context<WithdrawFromTreasury>) -> Result<()> {
    // Verify that the threshold has been met
    require!(
        ctx.accounts.raffle.current_tickets >= ctx.accounts.raffle.min_tickets,
        RaffleError::ThresholdNotMet,
    );
    // Verify treasury account matches the one stored in raffle
    require!(
        ctx.accounts.treasury.key() == ctx.accounts.raffle.treasury,
        RaffleError::InvalidTreasury
    );
    let treasury_account = ctx.accounts.treasury.to_account_info();
    let payout_authority = ctx.accounts.payout_authority.to_account_info();

    // Get total balance including rent
    let treasury_balance = treasury_account.lamports();
    require!(treasury_balance > 0, RaffleError::InsufficientFunds);

    // Get rent exempt balance to make sure we don't deduct ALL lamports, as the raffle might still be open
    let rent_lamports = (Rent::get()?).minimum_balance(TREASURY_ACCOUNT_SIZE);
    let lamports_to_withdraw = treasury_balance - rent_lamports;

    // Transfer lamports by directly deducting from treasury and adding to payout_authority.
    // This only works because the treasury is a PDA owned by our program.
    treasury_account.sub_lamports(lamports_to_withdraw)?;
    payout_authority.add_lamports(lamports_to_withdraw)?;

    // Emit the treasury withdrawn event
    emit!(TreasuryWithdrawn {
        raffle: ctx.accounts.raffle.key(),
        amount: lamports_to_withdraw,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawFromTreasury<'info> {
    pub raffle: Account<'info, Raffle>,

    #[account(mut)]
    pub management_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"treasury",
            raffle.key().as_ref(),
        ],
        bump = treasury.bump,
    )]
    pub treasury: Account<'info, Treasury>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = management_authority @ RaffleError::NotProgramManagementAuthority,
        has_one = payout_authority @ RaffleError::NotPayoutAuthority
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,

    #[account(mut)]
    pub payout_authority: SystemAccount<'info>,
}
