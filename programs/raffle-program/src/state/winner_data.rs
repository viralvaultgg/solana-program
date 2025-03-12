use anchor_lang::prelude::*;

// 8 (discriminator) + 4 (string length) + 854 (max string size)
pub const WINNER_DATA_ACCOUNT_SIZE: usize = 8 + 4 + 854;

#[account]
pub struct WinnerData {
    pub data: String,
}
