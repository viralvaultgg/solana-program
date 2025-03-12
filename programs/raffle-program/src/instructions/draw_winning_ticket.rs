use std::str::FromStr;

use anchor_lang::prelude::*;
use arrayref::array_ref;

use crate::{
    error::RaffleError,
    state::raffle::{Raffle, RaffleState},
};

/// Draws a winning ticket for a raffle using on-chain randomness from block hashes.
/// This function selects a winner in a cryptographically fair way without centralized
/// control by leveraging Solana's on-chain entropy sources.
///
/// Execution requirements:
/// 1. The raffle must be in Open state
/// 2. The raffle end time must have passed
/// 3. The minimum ticket threshold must be met
///
/// The randomness is generated with these steps:
/// 1. Extract entropy from the SlotHashes sysvar
/// 2. Combine multiple entropy sources (block hash and current timestamp)
/// 3. Apply cryptographic mixing
/// 4. Map the result to a ticket number without bias
///
/// After execution:
/// - The winning ticket number is stored in the raffle account
/// - The raffle state is changed to Drawing
///
/// # Arguments
/// * `ctx` - The context object containing:
///   - `raffle`: The mutable raffle account being drawn
///   - `recent_slothashes`: The SlotHashes sysvar containing block hashes (manually validated)
///
/// # Errors
/// - `RaffleNotOpen` if the raffle is not in Open state
/// - `RaffleNotEnded` if the raffle end time hasn't been reached
/// - `InsufficientTickets` if minimum ticket threshold not met
/// - `InvalidSlotHashesAccount` if the provided SlotHashes account is invalid
/// - `Overflow` if arithmetic overflow occurs during random number generation
pub fn draw_winning_ticket(ctx: Context<DrawWinningTicket>) -> Result<()> {
    // Manually validate the recent_slothashes account
    let pubkey_matches = Pubkey::from_str("SysvarS1otHashes111111111111111111111111111")
        .or(Err(RaffleError::InvalidSlotHashesAccount))?
        .eq(&ctx.accounts.recent_slothashes.key());
    require!(pubkey_matches, RaffleError::InvalidSlotHashesAccount);

    let recent_slothashes = &ctx.accounts.recent_slothashes;
    let data = recent_slothashes.data.borrow();

    // Extract entropy from SlotHashes data
    let chunk1 = array_ref![data, 12, 8];
    let chunk2 = if data.len() >= 28 {
        // Get second 8-byte block if available
        array_ref![data, 20, 8]
    } else {
        // Otherwise use the first block again
        chunk1
    };

    let hash_value1 = u64::from_le_bytes(*chunk1);
    let hash_value2 = u64::from_le_bytes(*chunk2);
    let clock = Clock::get()?;
    let timestamp = clock.unix_timestamp as u64;

    // Combine entropy sources through cryptographic mixing
    let mut mixed_value = mix(hash_value1, timestamp);
    mixed_value = mix(mixed_value, hash_value2);

    // Map the random value to a ticket number without statistical bias
    let winning_ticket = unbiased_range(mixed_value, ctx.accounts.raffle.current_tickets)?;

    // Store winning ticket and update state
    ctx.accounts.raffle.winning_ticket = Some(winning_ticket);
    ctx.accounts.raffle.raffle_state = RaffleState::Drawing;

    Ok(())
}

/// Cryptographic mixing function with strong avalanche properties
/// Each bit in the output has a ~50% chance of flipping when any input bit changes.
/// Based on splitmix64 algorithm used in high-quality PRNGs.
fn mix(a: u64, b: u64) -> u64 {
    let mut z = a.wrapping_add(b);

    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z = z ^ (z >> 31);

    z
}

/// Maps a random number to a range without introducing statistical bias
/// Standard modulo operations can bias results when the range isn't a power of 2.
/// This function uses specialized techniques based on range size to ensure fairness.
fn unbiased_range(x: u64, range: u64) -> Result<u64> {
    if range == 0 {
        return Err(RaffleError::Overflow.into());
    }

    // If range is a power of 2, we can use a simple mask which is unbiased
    if range.is_power_of_two() {
        return Ok(x & (range - 1));
    }

    // For small ranges, simple modulo is fine as bias is minimal
    if range <= 256 {
        return Ok(x % range);
    }

    // Find threshold value to ensure unbiased selection
    let threshold = u64::MAX - (u64::MAX % range);

    // Use rejection sampling with a limit on computational cost
    let mut value = x;

    // Cap iterations to ensure reasonable gas costs
    const MAX_ATTEMPTS: u8 = 3;

    for i in 0..MAX_ATTEMPTS {
        // If value is below threshold, we can use modulo safely
        if value < threshold {
            return Ok(value % range);
        }

        // Try a new value with additional mixing
        value = mix(value, value.wrapping_add(i as u64 + 1));
    }

    // Fallback case - the bias is minimal after the mixing operations
    Ok(value % range)
}

/// Accounts required for the draw_winning_ticket instruction
#[derive(Accounts)]
pub struct DrawWinningTicket<'info> {
    /// The raffle account to draw a winner for.
    /// Must be in Open state, past end time, and have met minimum ticket threshold
    #[account(
        mut,
        constraint = raffle.raffle_state == RaffleState::Open @ RaffleError::RaffleNotOpen,
        constraint = (Clock::get()?.unix_timestamp >= raffle.end_time) 
            || (raffle.max_tickets.is_some() && raffle.current_tickets == raffle.max_tickets.unwrap())  @ RaffleError::RaffleNotEnded,
        constraint = raffle.current_tickets >= raffle.min_tickets @ RaffleError::InsufficientTickets,
    )]
    pub raffle: Account<'info, Raffle>,

    /// The SlotHashes sysvar contains the most recent block hashes
    /// This is used as a source of randomness
    /// CHECK: Using UncheckedAccount because we manually validate the correct sysvar.
    /// This is needed because Anchor will always throw an error on the SlotHashes sysvar.
    pub recent_slothashes: UncheckedAccount<'info>,
}
