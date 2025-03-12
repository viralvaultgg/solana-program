import { describe, expect, it } from "bun:test";
import { BN, Program } from "@coral-xyz/anchor";
import {
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
} from "@solana/web3.js";
import { LiteSVMProvider, fromWorkspace } from "anchor-litesvm";
import type { RaffleProgram } from "../target/types/raffle_program";
const IDL = require("../target/idl/raffle_program.json");

describe("withdraw_from_treasury", async () => {
	it("should successfully withdraw from the treasury when the raffle has met the ticket threshold", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const payoutAuthority = new Keypair();

		// Mint some balance to the payoutAuthority to initialize it
		provider.client.airdrop(
			payoutAuthority.publicKey,
			BigInt(0.1 * LAMPORTS_PER_SOL),
		);

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: payoutAuthority.publicKey,
			})
			.rpc();

		const possibleStates = ["open", "drawing", "drawn", "claimed"];
		const thresholdCriteria: ("at" | "above")[] = ["at", "above"];

		for (const state of possibleStates) {
			for (const criteria of thresholdCriteria) {
				// Fetch config before creating raffle, so we can get the raffle PDA later
				const configId = PublicKey.findProgramAddressSync(
					[Buffer.from("config")],
					raffleProgram.programId,
				)[0];
				const config = await raffleProgram.account.config.fetch(configId);
				const creationTime = client.getClock().unixTimestamp;
				const initialRaffleCounter = config.raffleCounter;

				const metadataUri = "https://www.example.org";
				const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
				const minTickets = new BN(5);
				const endTime = new BN((creationTime + BigInt(3601)).toString());

				// Create raffle
				await raffleProgram.methods
					.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
					.rpc();
				const raffleAccountId = PublicKey.findProgramAddressSync(
					[
						Buffer.from("raffle"),
						new Uint8Array(new BN(initialRaffleCounter).toArray("le", 8)),
					],
					raffleProgram.programId,
				)[0];
				const treasuryId = PublicKey.findProgramAddressSync(
					[Buffer.from("treasury"), raffleAccountId.toBytes()],
					raffleProgram.programId,
				)[0];

				// Manually set the raffle state
				const currentTickets =
					criteria === "at" ? minTickets : minTickets.add(new BN(1)); // Make sure that the threshold is met
				const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
					metadataUri,
					ticketPrice,
					minTickets,
					currentTickets,
					endTime: new BN(creationTime.toString()),
					treasury: treasuryId,
					creationTime: new BN(creationTime.toString()),
					raffleState: {
						[state]: {},
					},
					winnerAddress: null,
					winningTicket: null,
					maxTickets: null,
				});
				provider.client.setAccount(raffleAccountId, {
					executable: false,
					owner: raffleProgram.programId,
					lamports: 1 * LAMPORTS_PER_SOL,
					data: raffleData,
				});

				// Mint balance to the treasury, so that the withdrawFromTreasury instruction can be executed
				provider.client.airdrop(
					treasuryId,
					BigInt(currentTickets.mul(ticketPrice).toString()),
				);

				// Verify that the treasury has more than the minRent
				const minRent = provider.client.minimumBalanceForRentExemption(
					BigInt(raffleProgram.account.treasury.size),
				);
				const treasuryBalanceBefore = provider.client.getBalance(treasuryId);
				if (!treasuryBalanceBefore) {
					throw new Error("Failed to fetch treasury balance");
				}
				expect(treasuryBalanceBefore).toEqual(
					minRent + BigInt(currentTickets.mul(ticketPrice).toString()),
				);

				const payoutAuthorityBalanceBefore = provider.client.getBalance(
					payoutAuthority.publicKey,
				);
				if (!payoutAuthorityBalanceBefore) {
					throw new Error("Failed to fetch payout authority balance");
				}

				// Withdraw from treasury
				await raffleProgram.methods
					.withdrawFromTreasury()
					.accountsStrict({
						config: configId,
						raffle: raffleAccountId,
						treasury: treasuryId,
						payoutAuthority: payoutAuthority.publicKey,
						managementAuthority: provider.publicKey,
						systemProgram: new PublicKey("11111111111111111111111111111111"),
					})
					.rpc();

				// Fetch treasury account balance
				const treasuryBalance = provider.client.getBalance(treasuryId);
				if (!treasuryBalance) {
					throw new Error("Failed to fetch treasury balance");
				}

				// Validate that only the minimum rent is left in the treasury, and that the payout authority has received the funds
				expect(treasuryBalance).toEqual(minRent);

				const payoutAuthorityBalanceAfter = provider.client.getBalance(
					payoutAuthority.publicKey,
				);
				if (!payoutAuthorityBalanceAfter) {
					throw new Error("Failed to fetch payout authority balance");
				}
				expect(payoutAuthorityBalanceAfter).toEqual(
					payoutAuthorityBalanceBefore +
						BigInt(ticketPrice.mul(currentTickets).toString()),
				);
			}
		}
	});

	it("should be possible to withdraw multiple times if the min threshold has been met and the raffle is still open", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const payoutAuthority = new Keypair();

		// Mint some balance to the payoutAuthority to initialize it
		provider.client.airdrop(
			payoutAuthority.publicKey,
			BigInt(0.1 * LAMPORTS_PER_SOL),
		);

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: payoutAuthority.publicKey,
			})
			.rpc();

		// Fetch config before creating raffle, so we can get the raffle PDA later
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const config = await raffleProgram.account.config.fetch(configId);
		const creationTime = client.getClock().unixTimestamp;
		const initialRaffleCounter = config.raffleCounter;

		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(5);
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		// Create raffle
		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
			.rpc();
		const raffleAccountId = PublicKey.findProgramAddressSync(
			[
				Buffer.from("raffle"),
				new Uint8Array(new BN(initialRaffleCounter).toArray("le", 8)),
			],
			raffleProgram.programId,
		)[0];
		const treasuryId = PublicKey.findProgramAddressSync(
			[Buffer.from("treasury"), raffleAccountId.toBytes()],
			raffleProgram.programId,
		)[0];

		// Buy and withdraw consecutively, multiple times in a row
		const rounds = 3;
		for (let i = 0; i < rounds; i++) {
			// Buy some tickets to meet the threshold
			const ticketsToBuy = minTickets;
			const buyer = new Keypair();

			// Calculate rent needed for ticket balance and entry account
			const rentBase = provider.client.getRent();
			const rentNeeded = rentBase.minimumBalance(
				BigInt(
					raffleProgram.account.entry.size +
						raffleProgram.account.ticketBalance.size,
				),
			);

			// Mint rent needed + balance to purchase ticket + 0.1 SOL for fees
			const totalTicketsPrice = ticketsToBuy.mul(ticketPrice);
			provider.client.airdrop(
				buyer.publicKey,
				BigInt(
					totalTicketsPrice
						.add(new BN(rentNeeded.toString()))
						.add(new BN(0.1 * LAMPORTS_PER_SOL))
						.toString(),
				),
			);

			// Create ticket balance
			await raffleProgram.methods
				.initTicketBalance()
				.accounts({
					signer: buyer.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([buyer])
				.rpc();

			const randomBytes = new Uint8Array(8);
			crypto.getRandomValues(randomBytes);
			const entrySeed = randomBytes;

			// Purchase tickets
			await raffleProgram.methods
				.buyTickets(ticketsToBuy, Array.from(entrySeed))
				.accounts({
					signer: buyer.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([buyer])
				.rpc();

			// Verify that the treasury has more than the minRent
			const minRent = provider.client.minimumBalanceForRentExemption(
				BigInt(raffleProgram.account.treasury.size),
			);
			const treasuryBalanceBefore = provider.client.getBalance(treasuryId);
			if (!treasuryBalanceBefore) {
				throw new Error("Failed to fetch treasury balance");
			}
			expect(treasuryBalanceBefore).toEqual(
				minRent + BigInt(ticketsToBuy.mul(ticketPrice).toString()),
			);

			const payoutAuthorityBalanceBefore = provider.client.getBalance(
				payoutAuthority.publicKey,
			);
			if (!payoutAuthorityBalanceBefore) {
				throw new Error("Failed to fetch payout authority balance");
			}

			// In the last round, we warp to the raffle end, close it and then try to withdraw
			if (i === rounds - 1) {
				// Time-travel to when the raffle ends
				const newClock = client.getClock();
				newClock.unixTimestamp = creationTime + BigInt(3602);
				client.setClock(newClock);

				// Close raffle
				await raffleProgram.methods
					.drawWinningTicket()
					.accounts({
						raffle: raffleAccountId,
						recentSlothashes: new PublicKey(
							"SysvarS1otHashes111111111111111111111111111",
						),
					})
					.rpc();
			}

			// Withdraw from treasury
			const tx = await raffleProgram.methods
				.withdrawFromTreasury()
				.accountsStrict({
					config: configId,
					raffle: raffleAccountId,
					treasury: treasuryId,
					payoutAuthority: payoutAuthority.publicKey,
					managementAuthority: provider.publicKey,
					systemProgram: new PublicKey("11111111111111111111111111111111"),
				})
				.transaction();

			// We add a transfer instruction here, so that the signature changes each time
			// This is a workaround for the current issue with litesvm, where the signature
			// is not updated when the transaction is sent because the blockhash is not updated
			tx.add(
				SystemProgram.transfer({
					fromPubkey: provider.publicKey,
					toPubkey: provider.publicKey,
					lamports: i,
				}),
			);

			await provider.sendAndConfirm?.(tx);

			// Fetch treasury account balance
			const treasuryBalance = provider.client.getBalance(treasuryId);
			if (!treasuryBalance) {
				throw new Error("Failed to fetch treasury balance");
			}

			// Validate that only the minimum rent is left in the treasury, and that the payout authority has received the funds
			expect(treasuryBalance).toEqual(minRent);

			const payoutAuthorityBalanceAfter = provider.client.getBalance(
				payoutAuthority.publicKey,
			);
			if (!payoutAuthorityBalanceAfter) {
				throw new Error("Failed to fetch payout authority balance");
			}
			expect(payoutAuthorityBalanceAfter).toEqual(
				payoutAuthorityBalanceBefore +
					BigInt(ticketPrice.mul(ticketsToBuy).toString()),
			);
		}
	});

	it("should be possible to withdraw from a raffle that has been drawn before the end time has passed, due to selling out", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const payoutAuthority = new Keypair();

		// Mint some balance to the payoutAuthority to initialize it
		provider.client.airdrop(
			payoutAuthority.publicKey,
			BigInt(0.1 * LAMPORTS_PER_SOL),
		);

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: payoutAuthority.publicKey,
			})
			.rpc();

		// Fetch config before creating raffle, so we can get the raffle PDA later
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const config = await raffleProgram.account.config.fetch(configId);
		const creationTime = client.getClock().unixTimestamp;
		const initialRaffleCounter = config.raffleCounter;

		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(5);
		const endTime = new BN((creationTime + BigInt(3601)).toString());
		const maxTickets = new BN(10);

		// Create raffle
		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, maxTickets)
			.rpc();
		const raffleAccountId = PublicKey.findProgramAddressSync(
			[
				Buffer.from("raffle"),
				new Uint8Array(new BN(initialRaffleCounter).toArray("le", 8)),
			],
			raffleProgram.programId,
		)[0];
		const treasuryId = PublicKey.findProgramAddressSync(
			[Buffer.from("treasury"), raffleAccountId.toBytes()],
			raffleProgram.programId,
		)[0];

		// Buy some tickets to meet the threshold
		const ticketsToBuy = maxTickets;
		const buyer = new Keypair();

		// Calculate rent needed for ticket balance and entry account
		const rentBase = provider.client.getRent();
		const rentNeeded = rentBase.minimumBalance(
			BigInt(
				raffleProgram.account.entry.size +
					raffleProgram.account.ticketBalance.size,
			),
		);

		// Mint rent needed + balance to purchase ticket + 0.1 SOL for fees
		const totalTicketsPrice = ticketsToBuy.mul(ticketPrice);
		provider.client.airdrop(
			buyer.publicKey,
			BigInt(
				totalTicketsPrice
					.add(new BN(rentNeeded.toString()))
					.add(new BN(0.1 * LAMPORTS_PER_SOL))
					.toString(),
			),
		);

		// Create ticket balance
		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				signer: buyer.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer])
			.rpc();

		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		// Purchase tickets
		await raffleProgram.methods
			.buyTickets(ticketsToBuy, Array.from(entrySeed))
			.accounts({
				signer: buyer.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer])
			.rpc();

		// Draw a winner
		await raffleProgram.methods
			.drawWinningTicket()
			.accounts({
				raffle: raffleAccountId,
				recentSlothashes: new PublicKey(
					"SysvarS1otHashes111111111111111111111111111",
				),
			})
			.rpc();

		// Verify that the treasury has more than the minRent
		const minRent = provider.client.minimumBalanceForRentExemption(
			BigInt(raffleProgram.account.treasury.size),
		);
		const treasuryBalanceBefore = provider.client.getBalance(treasuryId);
		if (!treasuryBalanceBefore) {
			throw new Error("Failed to fetch treasury balance");
		}
		expect(treasuryBalanceBefore).toEqual(
			minRent + BigInt(ticketsToBuy.mul(ticketPrice).toString()),
		);

		const payoutAuthorityBalanceBefore = provider.client.getBalance(
			payoutAuthority.publicKey,
		);
		if (!payoutAuthorityBalanceBefore) {
			throw new Error("Failed to fetch payout authority balance");
		}

		// Withdraw from treasury
		await raffleProgram.methods
			.withdrawFromTreasury()
			.accountsStrict({
				config: configId,
				raffle: raffleAccountId,
				treasury: treasuryId,
				payoutAuthority: payoutAuthority.publicKey,
				managementAuthority: provider.publicKey,
				systemProgram: new PublicKey("11111111111111111111111111111111"),
			})
			.rpc();

		// Fetch treasury account balance
		const treasuryBalance = provider.client.getBalance(treasuryId);
		if (!treasuryBalance) {
			throw new Error("Failed to fetch treasury balance");
		}

		// Validate that only the minimum rent is left in the treasury, and that the payout authority has received the funds
		expect(treasuryBalance).toEqual(minRent);

		const payoutAuthorityBalanceAfter = provider.client.getBalance(
			payoutAuthority.publicKey,
		);
		if (!payoutAuthorityBalanceAfter) {
			throw new Error("Failed to fetch payout authority balance");
		}
		expect(payoutAuthorityBalanceAfter).toEqual(
			payoutAuthorityBalanceBefore +
				BigInt(ticketPrice.mul(ticketsToBuy).toString()),
		);
	});

	it("should fail when the threshold is not met", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const payoutAuthority = new Keypair();

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: payoutAuthority.publicKey,
			})
			.rpc();

		// Fetch config before creating raffle, so we can get the raffle PDA later
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const config = await raffleProgram.account.config.fetch(configId);
		const creationTime = client.getClock().unixTimestamp;
		const initialRaffleCounter = config.raffleCounter;

		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(5);
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		// Create raffle
		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
			.rpc();
		const raffleAccountId = PublicKey.findProgramAddressSync(
			[
				Buffer.from("raffle"),
				new Uint8Array(new BN(initialRaffleCounter).toArray("le", 8)),
			],
			raffleProgram.programId,
		)[0];
		const treasuryId = PublicKey.findProgramAddressSync(
			[Buffer.from("treasury"), raffleAccountId.toBytes()],
			raffleProgram.programId,
		)[0];

		// Withdraw from treasury
		expect(
			raffleProgram.methods
				.withdrawFromTreasury()
				.accountsStrict({
					config: configId,
					raffle: raffleAccountId,
					treasury: treasuryId,
					payoutAuthority: payoutAuthority.publicKey,
					managementAuthority: provider.publicKey,
					systemProgram: new PublicKey("11111111111111111111111111111111"),
				})
				.rpc(),
		).rejects.toThrow(/ThresholdNotMet/);
	});

	it("should fail with a treasury that does not belong to the given raffle", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const payoutAuthority = new Keypair();

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: payoutAuthority.publicKey,
			})
			.rpc();

		// Fetch config before creating raffle, so we can get the raffle PDA later
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const creationTime = client.getClock().unixTimestamp;

		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(5);
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		// Create raffle
		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
			.rpc();

		const firstRaffleAccountId = PublicKey.findProgramAddressSync(
			[Buffer.from("raffle"), new Uint8Array(new BN(0).toArray("le", 8))],
			raffleProgram.programId,
		)[0];

		// Buy tickets on the first raffle, to meet threshold
		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				raffle: firstRaffleAccountId,
			})
			.rpc();

		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		await raffleProgram.methods
			.buyTickets(minTickets, Array.from(entrySeed))
			.accounts({ raffle: firstRaffleAccountId })
			.rpc();

		// Create another raffle
		await raffleProgram.methods
			.createRaffle(
				metadataUri,
				ticketPrice,
				endTime,
				minTickets.add(new BN(1)),
				null,
			)
			.rpc();

		const secondRaffleAccountId = PublicKey.findProgramAddressSync(
			[Buffer.from("raffle"), new Uint8Array(new BN(1).toArray("le", 8))],
			raffleProgram.programId,
		)[0];
		const secondTreasuryId = PublicKey.findProgramAddressSync(
			[Buffer.from("treasury"), secondRaffleAccountId.toBytes()],
			raffleProgram.programId,
		)[0];

		// Withdraw from first raffle, using the treasury of the second raffle
		expect(
			raffleProgram.methods
				.withdrawFromTreasury()
				.accountsStrict({
					config: configId,
					raffle: firstRaffleAccountId,
					treasury: secondTreasuryId,
					payoutAuthority: payoutAuthority.publicKey,
					managementAuthority: provider.publicKey,
					systemProgram: new PublicKey("11111111111111111111111111111111"),
				})
				.rpc(),
		).rejects.toThrow(/ConstraintSeeds/);
	});

	it("should fail when sending transaction with an account other than the management authority", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const payoutAuthority = new Keypair();

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: payoutAuthority.publicKey,
			})
			.rpc();

		// Fetch config before creating raffle, so we can get the raffle PDA later
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const config = await raffleProgram.account.config.fetch(configId);
		const creationTime = client.getClock().unixTimestamp;
		const initialRaffleCounter = config.raffleCounter;

		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(5);
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		// Create raffle
		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
			.rpc();
		const raffleAccountId = PublicKey.findProgramAddressSync(
			[
				Buffer.from("raffle"),
				new Uint8Array(new BN(initialRaffleCounter).toArray("le", 8)),
			],
			raffleProgram.programId,
		)[0];
		const treasuryId = PublicKey.findProgramAddressSync(
			[Buffer.from("treasury"), raffleAccountId.toBytes()],
			raffleProgram.programId,
		)[0];

		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				raffle: raffleAccountId,
			})
			.rpc();

		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		await raffleProgram.methods
			.buyTickets(minTickets, Array.from(entrySeed))
			.accounts({ raffle: raffleAccountId })
			.rpc();

		// Withdraw from treasury, using not the management authority
		const account = new Keypair();
		provider.client.airdrop(account.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

		expect(
			raffleProgram.methods
				.withdrawFromTreasury()
				.accountsStrict({
					config: configId,
					raffle: raffleAccountId,
					treasury: treasuryId,
					payoutAuthority: payoutAuthority.publicKey,
					managementAuthority: account.publicKey,
					systemProgram: new PublicKey("11111111111111111111111111111111"),
				})
				.signers([account])
				.rpc(),
		).rejects.toThrow(/NotProgramManagementAuthority/);
	});

	it("should fail when using a different payout authority than is set in the config", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const payoutAuthority = new Keypair();

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: payoutAuthority.publicKey,
			})
			.rpc();

		// Fetch config before creating raffle, so we can get the raffle PDA later
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const config = await raffleProgram.account.config.fetch(configId);
		const creationTime = client.getClock().unixTimestamp;
		const initialRaffleCounter = config.raffleCounter;

		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(5);
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		// Create raffle
		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
			.rpc();
		const raffleAccountId = PublicKey.findProgramAddressSync(
			[
				Buffer.from("raffle"),
				new Uint8Array(new BN(initialRaffleCounter).toArray("le", 8)),
			],
			raffleProgram.programId,
		)[0];
		const treasuryId = PublicKey.findProgramAddressSync(
			[Buffer.from("treasury"), raffleAccountId.toBytes()],
			raffleProgram.programId,
		)[0];

		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				raffle: raffleAccountId,
			})
			.rpc();

		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		await raffleProgram.methods
			.buyTickets(minTickets, Array.from(entrySeed))
			.accounts({ raffle: raffleAccountId })
			.rpc();

		// Withdraw from treasury, using not the payout authority
		const account = new Keypair();
		provider.client.airdrop(account.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

		expect(
			raffleProgram.methods
				.withdrawFromTreasury()
				.accountsStrict({
					config: configId,
					raffle: raffleAccountId,
					treasury: treasuryId,
					payoutAuthority: account.publicKey,
					managementAuthority: provider.publicKey,
					systemProgram: new PublicKey("11111111111111111111111111111111"),
				})
				.rpc(),
		).rejects.toThrow(/NotPayoutAuthority/);
	});
});
