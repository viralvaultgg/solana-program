use anchor_lang::prelude::*;
use instructions::*;

pub mod error;
pub mod instructions;
pub mod state;

declare_id!("V1RALU8Rkwxb6uc6bALeNeMgdNoMZMx4L14Dojkgy2X");

#[program]
pub mod raffle_program {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        instructions::init_config::init_config(ctx)
    }

    pub fn create_raffle(
        ctx: Context<CreateRaffle>,
        metadata_uri: String,
        ticket_price: u64,
        end_time: i64,
        min_tickets: u64,
        max_tickets: Option<u64>,
    ) -> Result<()> {
        instructions::create_raffle::create_raffle(
            ctx,
            metadata_uri,
            ticket_price,
            end_time,
            min_tickets,
            max_tickets,
        )
    }

    pub fn buy_tickets(
        ctx: Context<BuyTickets>,
        ticket_count: u64,
        entry_seed: [u8; 8],
    ) -> Result<()> {
        instructions::buy_tickets::buy_tickets(ctx, ticket_count, entry_seed)
    }

    pub fn init_ticket_balance(ctx: Context<InitTicketBalance>) -> Result<()> {
        instructions::init_ticket_balance::init_ticket_balance(ctx)
    }

    pub fn expire_raffle(ctx: Context<ExpireRaffle>) -> Result<()> {
        instructions::expire_raffle::expire_raffle(ctx)
    }

    pub fn reclaim_expired_tickets(ctx: Context<ReclaimExpiredTickets>) -> Result<()> {
        instructions::reclaim_expired_tickets::reclaim_expired_tickets(ctx)
    }

    pub fn withdraw_from_treasury(ctx: Context<WithdrawFromTreasury>) -> Result<()> {
        instructions::withdraw_from_treasury::withdraw_from_treasury(ctx)
    }

    pub fn set_winner(ctx: Context<SetWinner>, entry_seed: [u8; 8]) -> Result<()> {
        instructions::set_winner::set_winner(ctx, entry_seed)
    }

    pub fn draw_winning_ticket(ctx: Context<DrawWinningTicket>) -> Result<()> {
        instructions::draw_winning_ticket::draw_winning_ticket(ctx)
    }

    pub fn submit_winner_data(ctx: Context<SubmitWinnerData>, data: String) -> Result<()> {
        instructions::submit_winner_data::submit_winner_data(ctx, data)
    }
}
