use anchor_lang::prelude::*;

// 8 discriminator, 32 pubkey, 1 bump
pub const TREASURY_ACCOUNT_SIZE: usize = 8 + 32 + 1;

#[account]
pub struct Treasury {
    pub raffle: Pubkey,
    pub bump: u8,
}
