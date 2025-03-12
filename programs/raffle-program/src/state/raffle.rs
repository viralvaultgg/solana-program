use anchor_lang::prelude::*;

// Space calculation:
// 8 (discriminator) +
// 32 (treasury) +
// 4 (length of metadata_uri) +
// 256 (metadata_uri) +
// 8 (ticket_price) +
// 8 (current_tickets) +
// 8 (min_tickets) +
// 9 (max_tickets: Option<u64>) +
// 8 (creation_time) +
// 8 (end_time) +
// 1 (raffle_state) +
// 33 (winner_address: Option<Pubkey>) +
// 9 (winning_ticket: Option<u64>) =
// 383 total bytes
pub const RAFFLE_ACCOUNT_SIZE: usize = 8 + 32 + 4 + 256 + 8 + 8 + 8 + 9 + 8 + 8 + 1 + 33 + 9;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum RaffleState {
    Open = 0,
    Drawing = 1,
    Drawn = 2,
    Expired = 3,
    Claimed = 4,
}

#[account]
pub struct Raffle {
    pub treasury: Pubkey,
    pub metadata_uri: String,
    pub ticket_price: u64,
    pub current_tickets: u64,
    pub min_tickets: u64,
    pub max_tickets: Option<u64>,
    pub creation_time: i64,
    pub end_time: i64,
    pub raffle_state: RaffleState,
    pub winner_address: Option<Pubkey>,
    pub winning_ticket: Option<u64>,
}
