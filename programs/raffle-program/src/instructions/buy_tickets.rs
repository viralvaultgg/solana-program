use anchor_lang::prelude::*;

use crate::{
    error::RaffleError,
    state::{
        entry::Entry,
        raffle::{Raffle, RaffleState},
        TicketBalance, Treasury, ENTRY_ACCOUNT_SIZE,
    },
};

/// Event emitted when tickets are purchased
#[event]
pub struct TicketsPurchased {
    /// The pubkey of the raffle
    pub raffle: Pubkey,
    /// The buyer's address
    pub buyer: Pubkey,
    /// Number of tickets purchased
    pub ticket_count: u64,
    /// Total amount paid in lamports
    pub payment_amount: u64,
    /// Starting ticket index for this purchase
    pub ticket_start_index: u64,
    /// The seed that was used to create the entry
    pub entry_seed: [u8; 8],
}

/// Instruction to purchase tickets for a raffle
///
/// # Arguments
/// * `ctx` - The context object containing all required accounts
/// * `ticket_count` - The number of tickets to purchase
///
/// # Security Considerations
/// The instruction performs several critical checks:
/// 1. Validates ticket count is greater than 0
/// 2. If the raffle has a maximum ticket count, ensures the purchase does not exceed that limit
/// 3. Ensures buyer has sufficient funds to purchase tickets
/// 4. Verifies the treasury account matches the one stored in raffle
/// 5. Validates raffle is in Open state through account constraints
/// 6. Ensures raffle hasn't ended through timestamp constraint
/// 7. Uses PDAs with proper seeds for entry and ticket_balance accounts
///
/// # Account Validations
/// * Raffle - Must be in Open state and not expired
/// * Entry - New PDA initialized for this purchase
/// * TicketBalance - Existing PDA tracking user's total tickets
/// * Signer - Must have sufficient funds for purchase
/// * Treasury - Must match raffle's treasury and uses proper PDA seeds
///
/// # Implementation Notes
/// - Uses checked arithmetic operations to prevent overflow
/// - Updates state before performing external calls
/// - Implements safe lamport calculations
pub fn buy_tickets(ctx: Context<BuyTickets>, ticket_count: u64, entry_seed: [u8; 8]) -> Result<()> {
    // Validate ticket count
    require!(ticket_count > 0, RaffleError::InvalidTicketCount);

    // Check if still allowed to buy tickets
    if let Some(max_tickets) = ctx.accounts.raffle.max_tickets {
        require!(
            ctx.accounts.raffle.current_tickets < max_tickets, 
            RaffleError::MaximumTicketsSold
        );

        require!(
            ctx.accounts.raffle.max_tickets >= ctx.accounts.raffle.current_tickets.checked_add(ticket_count), 
            RaffleError::PurchaseExceedsThreshold
        );
    }
    
    // Calculate payment amount with overflow protection
    let payment_amount = ticket_count
        .checked_mul(ctx.accounts.raffle.ticket_price)
        .ok_or(RaffleError::Overflow)?;
    
    // Validate buyer has sufficient funds using checked comparison
    require!(
        ctx.accounts.signer.lamports()
            .checked_sub(payment_amount)
            .ok_or(RaffleError::InsufficientFunds)? > 0,
        RaffleError::InsufficientFunds,
    );

    // Ensure treasury account matches the one stored in raffle
    require!(
        ctx.accounts.treasury.key() == ctx.accounts.raffle.treasury.key(),
        RaffleError::InvalidTreasury,
    );

    // Verify ticket balance account is initialized
    require!(
        ctx.accounts.ticket_balance.owner == ctx.accounts.signer.key(),
        RaffleError::TicketBalanceNotInitialized,
    );

    // Initialize entry data in the PDA
    // Each entry represents a single purchase transaction
    let entry = &mut ctx.accounts.entry;
    entry.raffle = ctx.accounts.raffle.key();
    entry.owner = ctx.accounts.signer.key();
    entry.ticket_count = ticket_count;
    entry.ticket_start_index = ctx.accounts.raffle.current_tickets;
    entry.seed = entry_seed;

    // Update raffle state with new ticket count using checked arithmetic
    ctx.accounts.raffle.current_tickets = ctx.accounts.raffle.current_tickets
        .checked_add(ticket_count)
        .ok_or(RaffleError::Overflow)?;

    // Update user's total ticket balance with overflow protection
    let ticket_balance = &mut ctx.accounts.ticket_balance;
    ticket_balance.ticket_count = ticket_balance.ticket_count
        .checked_add(ticket_count)
        .ok_or(RaffleError::Overflow)?;

    // Store pre-transfer balance for verification
    let pre_transfer_balance = ctx.accounts.treasury.to_account_info().lamports();

    // Transfer lamports from the buyer to the raffle treasury
    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.signer.key(),
            &ctx.accounts.treasury.key(),
            payment_amount,
        ),
        &[
            ctx.accounts.signer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
        ],
    )?;

    // Verify the transfer was successful by checking treasury balance
    let post_transfer_balance = ctx.accounts.treasury.to_account_info().lamports();
    require!(
        post_transfer_balance == pre_transfer_balance.checked_add(payment_amount).ok_or(RaffleError::Overflow)?,
        RaffleError::TransferFailed
    );

    // Emit the tickets purchased event
    emit!(TicketsPurchased {
        raffle: ctx.accounts.raffle.key(),
        buyer: ctx.accounts.signer.key(),
        ticket_count,
        payment_amount,
        ticket_start_index: entry.ticket_start_index,
        entry_seed,
    });

    Ok(())
}

/// Accounts required for the buy_tickets instruction
#[derive(Accounts)]
#[instruction(ticket_count: u64, entry_seed: [u8; 8])]
pub struct BuyTickets<'info> {
    /// The raffle account that tickets are being purchased for
    /// Must be in Open state and not past end time
    #[account(
        mut,
        constraint = raffle.raffle_state == RaffleState::Open @ RaffleError::RaffleNotOpen,
        constraint = Clock::get()?.unix_timestamp < raffle.end_time @ RaffleError::RaffleEnded,
    )]
    pub raffle: Account<'info, Raffle>,

    /// New entry account created for this purchase
    /// PDA with empty seeds
    #[account(
        init,
        payer = signer,
        space = ENTRY_ACCOUNT_SIZE,
        seeds = [
            b"entry",
            raffle.key().as_ref(),
            entry_seed.as_ref()
        ],
        bump,
    )]
    pub entry: Account<'info, Entry>,

    /// User's ticket balance account
    /// PDA with seeds ["ticket_balance", raffle_key, signer_key]
    #[account(
        mut, 
        seeds = [
            b"ticket_balance",
            raffle.key().as_ref(),
            signer.key().as_ref()
        ], 
        bump = ticket_balance.bump
    )]
    pub ticket_balance: Account<'info, TicketBalance>,

    /// The account purchasing tickets and paying for the entry account
    #[account(mut)]
    pub signer: Signer<'info>,

    /// Required for creating the entry account
    pub system_program: Program<'info, System>,

    /// Treasury account that receives payment for tickets
    /// PDA with seeds ["treasury", raffle_key]
    #[account(
        mut,
        seeds = [
            b"treasury",
            raffle.key().as_ref(),
        ],
        bump = treasury.bump,
    )]
    pub treasury: Account<'info, Treasury>,
}
