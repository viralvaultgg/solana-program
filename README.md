# Viral Vault Raffle Program

A Solana smart contract for creating and managing decentralized raffles with transparent winner selection.

## Overview

The Viral Vault Solana program implements a complete raffle system with the following features:

- Raffle creation with configurable parameters (ticket price, duration, limits)
- Ticket purchasing and tracking
- Transparent winner selection using on-chain entropy
- Prize claiming and treasury management
- Built-in security constraints and administrative controls

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) - Required for contract development
- [Solana CLI Tools](https://docs.solana.com/cli/install-solana-cli-tools) - For interacting with Solana blockchain
- [Anchor](https://www.anchor-lang.com/docs/installation) - Framework for Solana program development
- [Bun](https://bun.sh/) - JavaScript runtime for testing

## Building

To build the program:

```bash
# Install dependencies
cargo build

# Build with Anchor
anchor build
```

## Testing

To run the tests:

```bash
# Run all tests using Anchor
anchor test

# Run specific tests only
bun test tests/<test_file>.ts
```

## Contract Structure

The contract is organized as follows:

- **Raffle**: Core account structure for raffle information and state
- **Entry**: Tracks ticket purchases by users
- **Treasury**: Manages funds for each raffle
- **Config**: Global configuration parameters
- **TicketBalance**: Tracks ticket balances for users

## Raffle Lifecycle

1. **Creation**: Admin creates a raffle with parameters
2. **Open**: Users can purchase tickets 
3. **Drawing**: Admin initiates the drawing process
4. **Drawn**: Winner is selected using on-chain randomness
5. **Claimed/Expired**: Winner claims prize or raffle expires

## Security Features

- Uses program-derived addresses (PDAs) for security: Created accounts are owned by the program and have no associated private keys.
- Implements checked arithmetic to prevent overflows
- Validates all inputs and authority
- Uses Solana's SlotHashes with advanced mixing for secure randomness
- Enforces constraints on ticket prices and counts

## License

See [LICENSE.md](LICENSE.md)