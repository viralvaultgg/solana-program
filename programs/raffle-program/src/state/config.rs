use anchor_lang::prelude::*;

// 8 discriminator + 32 payout_authority + 32 management_authority + 32 upgrade_authority + 1 bump + 8 raffle_counter
pub const CONFIG_ACCOUNT_SIZE: usize = 8 + 32 + 32 + 32 + 1 + 8;

#[account]
pub struct Config {
    pub payout_authority: Pubkey,
    pub management_authority: Pubkey,
    pub upgrade_authority: Pubkey,
    pub bump: u8,
    pub raffle_counter: u64,
}
