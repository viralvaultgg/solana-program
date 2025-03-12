use crate::state::{Config, CONFIG_ACCOUNT_SIZE};
use anchor_lang::prelude::*;

/// Instruction to initialize the program configuration
/// This should be called once during program deployment
///
/// # Security Considerations
/// - Creates a PDA with seed "config" to store program authority
/// - Only needs to be called once during deployment
/// - The caller of this instruction must be the owner of the program
/// - The management authority will be set and locked
/// - The payout authority will be set and locked
///
/// # Account Validations
/// * Config - New PDA initialized with proper space allocation
/// * Upgrade Authority - Signer needs to be the owner of the program
/// * Management Authority - Account becomes the program management authority
/// * Payout Authority - Account becomes the program payout authority
pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
    ctx.accounts.config.payout_authority = ctx.accounts.payout_authority.key();
    ctx.accounts.config.management_authority = ctx.accounts.management_authority.key();
    ctx.accounts.config.upgrade_authority = ctx.accounts.upgrade_authority.key();
    ctx.accounts.config.bump = ctx.bumps.config;
    ctx.accounts.config.raffle_counter = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(
        init,
        payer = upgrade_authority,
        space = CONFIG_ACCOUNT_SIZE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    pub payout_authority: SystemAccount<'info>,
    pub management_authority: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}
