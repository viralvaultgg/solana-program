use anchor_lang::prelude::*;

// 8 discriminator + 32 raffle + 32 owner + 8 ticket_count + 8 ticket_start_index + 8 seed
pub const ENTRY_ACCOUNT_SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8;

#[account]
pub struct Entry {
    pub raffle: Pubkey,
    pub owner: Pubkey,
    pub ticket_count: u64,
    pub ticket_start_index: u64,
    pub seed: [u8; 8],
}
