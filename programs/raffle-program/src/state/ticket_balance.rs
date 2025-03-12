use anchor_lang::prelude::*;

// 8 discriminator + 32 owner + 8 ticket_count + 1 bump
pub const TICKET_BALANCE_ACCOUNT_SIZE: usize = 8 + 32 + 8 + 1;

#[account]
pub struct TicketBalance {
    pub owner: Pubkey,
    pub ticket_count: u64,
    pub bump: u8,
}
