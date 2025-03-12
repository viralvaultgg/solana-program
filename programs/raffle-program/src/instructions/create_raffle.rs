use crate::{
    error::RaffleError,
    state::{
        raffle::{Raffle, RaffleState},
        Config, Treasury, RAFFLE_ACCOUNT_SIZE, TREASURY_ACCOUNT_SIZE,
    },
};
use anchor_lang::prelude::*;

// Constants for validation
const MAX_TICKET_PRICE: u64 = 100_000_000_000; // 100 SOL
const MIN_TICKET_PRICE: u64 = 100_000_000; // 0.1 SOL
const MAX_MIN_TICKETS: u64 = 1_000_000; // 1 million tickets
const MAX_DURATION: i64 = 30 * 24 * 60 * 60; // 30 days in seconds
const MIN_DURATION: i64 = 1 * 60 * 60; // 1 hour in seconds

// Valid URI prefixes
const VALID_URI_PREFIXES: [&str; 3] = [
    "https://",     // Standard HTTPS
    "ipfs://",      // IPFS protocol
    "ipfs://ipfs/", // Alternative IPFS format
];

/// Event emitted when a raffle is created
#[event]
pub struct RaffleCreated {
    /// The pubkey of the created raffle
    pub raffle: Pubkey,
    /// The metadata URI for the raffle
    pub metadata_uri: String,
    /// Price per ticket in lamports
    pub ticket_price: u64,
    /// Minimum number of tickets required
    pub min_tickets: u64,
    /// When the raffle ends
    pub end_time: i64,
    /// When the raffle was created
    pub creation_time: i64,
}

/// Instruction to create a new raffle with specified parameters
///
/// # Arguments
/// * `ctx` - The context object containing all required accounts
/// * `metadata_uri` - URI pointing to the raffle's metadata (max 256 chars)
/// * `ticket_price` - Price per ticket in lamports (must be > 0)
/// * `min_tickets` - Minimum number of tickets that must be sold (must be > 0)
/// * `end_time` - Unix timestamp when the raffle ends (must be in future)
///
/// # Security Considerations
/// The instruction performs several critical checks:
/// 1. Validates caller is the program authority via config PDA
/// 2. Validates metadata_uri length is <= 256 characters and starts with https://, ipfs://, or ipfs://ipfs/
/// 3. Ensures ticket_price is greater than 0 and <= 100 SOL
/// 4. Ensures min_tickets is greater than 0 and <= 1 million
/// 5. Verifies end_time is in the future but not more than 30 days ahead
/// 6. Uses a PDA for treasury with proper seeds
/// 7. Validates authority has sufficient funds for account creation
///
/// # Account Validations
/// * Raffle - New account initialized with proper space allocation
/// * Authority - Must be program authority stored in config account
/// * Treasury - New PDA initialized with seeds ["treasury", raffle_key]
/// * Config - PDA storing program authority
///
/// # Implementation Notes
/// - Initializes raffle in Open state
/// - Sets creation time to current timestamp
/// - Creates treasury PDA linked to raffle
/// - Space allocation accounts for max metadata_uri length
pub fn create_raffle(
    ctx: Context<CreateRaffle>,
    metadata_uri: String,
    ticket_price: u64,
    end_time: i64,
    min_tickets: u64,
    max_tickets: Option<u64>,
) -> Result<()> {
    let current_time = Clock::get()?.unix_timestamp;

    // Validate inputs
    // URI format check - must start with one of the valid prefixes
    require!(
        VALID_URI_PREFIXES
            .iter()
            .any(|prefix| metadata_uri.starts_with(prefix)),
        RaffleError::InvalidMetadataUri
    );
    require!(metadata_uri.len() <= 256, RaffleError::MetadataUriTooLong);

    // Price checks
    require!(
        ticket_price >= MIN_TICKET_PRICE,
        RaffleError::TicketPriceTooLow
    );
    require!(
        ticket_price <= MAX_TICKET_PRICE,
        RaffleError::TicketPriceTooHigh
    );

    // Ticket count checks
    require!(min_tickets > 0, RaffleError::MinTicketsTooLow);
    require!(
        min_tickets <= MAX_MIN_TICKETS,
        RaffleError::MinTicketsTooHigh
    );

    // Check that max tickets is greater than or equal to min tickets
    if let Some(max_tickets) = max_tickets {
        require!(max_tickets >= min_tickets, RaffleError::MaxTicketsTooLow);
    }

    // Time checks
    require!(
        end_time > current_time.checked_add(MIN_DURATION).unwrap(),
        RaffleError::EndTimeTooClose
    );
    require!(
        end_time <= current_time.checked_add(MAX_DURATION).unwrap(),
        RaffleError::DurationTooLong
    );

    // Set inputs from transaction data
    ctx.accounts.raffle.metadata_uri = metadata_uri;
    ctx.accounts.raffle.ticket_price = ticket_price;
    ctx.accounts.raffle.min_tickets = min_tickets;
    ctx.accounts.raffle.end_time = end_time;
    ctx.accounts.raffle.treasury = ctx.accounts.treasury.key();
    ctx.accounts.treasury.bump = ctx.bumps.treasury;
    ctx.accounts.treasury.raffle = ctx.accounts.raffle.key();
    ctx.accounts.raffle.max_tickets = max_tickets;

    // Set default values
    ctx.accounts.raffle.current_tickets = 0;
    ctx.accounts.raffle.creation_time = current_time;
    ctx.accounts.raffle.raffle_state = RaffleState::Open;
    ctx.accounts.raffle.winner_address = None;
    ctx.accounts.raffle.winning_ticket = None;

    // Increment the raffle counter
    ctx.accounts.config.raffle_counter = ctx
        .accounts
        .config
        .raffle_counter
        .checked_add(1)
        .ok_or(RaffleError::Overflow)?;

    // Emit the raffle created event
    emit!(RaffleCreated {
        raffle: ctx.accounts.raffle.key(),
        metadata_uri: ctx.accounts.raffle.metadata_uri.clone(),
        ticket_price,
        min_tickets,
        end_time,
        creation_time: current_time,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CreateRaffle<'info> {
    #[account(
        init,
        payer = management_authority,
        space = RAFFLE_ACCOUNT_SIZE,
        seeds = [
            b"raffle",
            config.raffle_counter.to_le_bytes().as_ref(),
        ],
        bump
    )]
    pub raffle: Account<'info, Raffle>,

    #[account(mut)]
    pub management_authority: Signer<'info>,

    #[account(
        init,
        payer = management_authority,
        space = TREASURY_ACCOUNT_SIZE,
        seeds = [
            b"treasury",
            raffle.key().as_ref(),
        ],
        bump,
    )]
    pub treasury: Account<'info, Treasury>,

    /// The config account storing upgrade, management and payout authorities, and raffle counter
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = management_authority @ RaffleError::NotProgramManagementAuthority,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}
