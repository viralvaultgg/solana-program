use anchor_lang::error_code;

#[error_code]
pub enum RaffleError {
    Overflow,
    MetadataUriTooLong,
    TicketPriceTooLow,
    MinTicketsTooLow,
    InvalidTicketCount,
    InsufficientFunds,
    RaffleNotOpen,
    InvalidTreasury,
    RaffleNotExpired,
    OwnerMismatch,
    ThresholdIsMet,
    NoTicketsOwned,
    #[msg("Only the program management authority can create raffles")]
    NotProgramManagementAuthority,
    #[msg("Only the payout authority may be used to withdraw from the treasury")]
    NotPayoutAuthority,
    #[msg("Ticket price exceeds maximum allowed")]
    TicketPriceTooHigh,
    #[msg("Minimum tickets exceeds maximum allowed")]
    MinTicketsTooHigh,
    #[msg("Raffle duration exceeds maximum allowed")]
    DurationTooLong,
    #[msg("Invalid metadata URI format")]
    InvalidMetadataUri,
    #[msg("End time must be at least 1 hour in the future")]
    EndTimeTooClose,
    #[msg("Ticket balance account is not initialized for this user")]
    TicketBalanceNotInitialized,
    #[msg("Treasury transfer failed")]
    TransferFailed,
    #[msg("Raffle has ended")]
    RaffleEnded,
    #[msg("Raffle has not ended yet")]
    RaffleNotEnded,
    #[msg("Insufficient tickets sold")]
    InsufficientTickets,
    #[msg("Invalid SlotHashes account provided")]
    InvalidSlotHashesAccount,
    #[msg("Raffle is not in Drawing state")]
    RaffleNotDrawing,
    #[msg("No winning ticket has been drawn")]
    NoWinningTicket,
    #[msg("Entry does not contain the winning ticket")]
    InvalidWinningEntry,
    #[msg("The raffle has not been drawn yet")]
    RaffleNotDrawn,
    #[msg("Only the winner can submit data")]
    NotWinner,
    #[msg("Encrypted username exceeds maximum length of 1024 bytes")]
    InvalidDataLength,
    #[msg("Minimum ticket threshold is not met")]
    ThresholdNotMet,
    #[msg("All available tickets have been sold")]
    MaximumTicketsSold,
    #[msg("Executing this purchase would exceed the maximum threshold. Please buy fewer tickets.")]
    PurchaseExceedsThreshold,
    #[msg("Max tickets must be greater than min tickets")]
    MaxTicketsTooLow,
}
