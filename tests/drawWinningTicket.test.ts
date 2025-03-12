import { describe, expect, it } from "bun:test";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { LiteSVMProvider, fromWorkspace } from "anchor-litesvm";
import type { RaffleProgram } from "../target/types/raffle_program";
const IDL = require("../target/idl/raffle_program.json");

describe("draw_winning_ticket", async () => {
	it("should successfully draw a winning ticket on a raffle that is in open state, has ended and has met the ticket threshold", async () => {
		const client = fromWorkspace(".");
		client.withSysvars();
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
				upgradeAuthority: provider.publicKey,
			})
			.rpc();

		const inputs: {
			numBuyers: number;
			ticketsPerBuyer: number;
			minTickets: number;
			maxTickets?: number;
		}[] = [
			{ numBuyers: 1, ticketsPerBuyer: 1, minTickets: 1 },
			{ numBuyers: 100, ticketsPerBuyer: 2, minTickets: 50 },
			{ numBuyers: 100, ticketsPerBuyer: 100, minTickets: 500 },
			{ numBuyers: 1, ticketsPerBuyer: 1, minTickets: 1, maxTickets: 10 },
			{ numBuyers: 100, ticketsPerBuyer: 2, minTickets: 50, maxTickets: 1000 },
			{
				numBuyers: 100,
				ticketsPerBuyer: 100,
				minTickets: 500,
				maxTickets: 50000,
			},
		];

		for (const input of inputs) {
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
			const minTickets = new BN(input.minTickets);
			const endTime = new BN((creationTime + BigInt(3601)).toString());
			const maxTickets = input.maxTickets ? new BN(input.maxTickets) : null;

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

			for (let i = 0; i < input.numBuyers; i++) {
				const buyer = new Keypair();
				const amountToPurchase = new BN(input.ticketsPerBuyer);

				// Calculate rent needed for ticket balance and entry account
				const rentBase = provider.client.getRent();
				const rentNeeded = rentBase.minimumBalance(
					BigInt(
						raffleProgram.account.entry.size +
							raffleProgram.account.ticketBalance.size,
					),
				);

				// Mint rent needed + balance to purchase ticket + 0.1 SOL for fees
				const totalTicketsPrice = amountToPurchase.mul(ticketPrice);
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
					.buyTickets(amountToPurchase, Array.from(entrySeed))
					.accounts({
						signer: buyer.publicKey,
						raffle: new PublicKey(raffleAccountId),
					})
					.signers([buyer])
					.rpc();
			}

			// Set time so that the raffle has ended
			const newClock = client.getClock();
			newClock.unixTimestamp = creationTime + BigInt(3601);
			client.setClock(newClock);

			// Draw winning ticket
			await raffleProgram.methods
				.drawWinningTicket()
				.accounts({
					raffle: new PublicKey(raffleAccountId),
					recentSlothashes: new PublicKey(
						"SysvarS1otHashes111111111111111111111111111",
					),
				})
				.rpc();

			// Validate the raffle state
			const raffleAccount =
				await raffleProgram.account.raffle.fetch(raffleAccountId);

			expect(raffleAccount.raffleState.drawing).toBeDefined();
			expect(raffleAccount.raffleState.open).toBeUndefined();
			expect(raffleAccount.raffleState.drawn).toBeUndefined();
			expect(raffleAccount.raffleState.expired).toBeUndefined();
			expect(raffleAccount.raffleState.claimed).toBeUndefined();
			expect(raffleAccount.winningTicket).toBeDefined();

			const totalTickets = input.numBuyers * input.ticketsPerBuyer;
			expect(raffleAccount.winningTicket?.lt(new BN(totalTickets))).toBeTrue();
			expect(raffleAccount.winningTicket?.gte(new BN(0))).toBeTrue();
		}
	});

	it("should successfully draw a winning ticket on a raffle that is in open state, has sold out, but has not yet ended", async () => {
		const client = fromWorkspace(".");
		client.withSysvars();
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
				upgradeAuthority: provider.publicKey,
			})
			.rpc();

		const inputs: {
			numBuyers: number;
			ticketsPerBuyer: number;
			minTickets: number;
			maxTickets: number;
		}[] = [
			{ numBuyers: 1, ticketsPerBuyer: 1, minTickets: 1, maxTickets: 1 },
			{ numBuyers: 100, ticketsPerBuyer: 2, minTickets: 50, maxTickets: 200 },
			{
				numBuyers: 100,
				ticketsPerBuyer: 100,
				minTickets: 500,
				maxTickets: 10000,
			},
		];

		for (const input of inputs) {
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
			const minTickets = new BN(input.minTickets);
			const endTime = new BN((creationTime + BigInt(3601)).toString());
			const maxTickets = input.maxTickets ? new BN(input.maxTickets) : null;

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

			for (let i = 0; i < input.numBuyers; i++) {
				const buyer = new Keypair();
				const amountToPurchase = new BN(input.ticketsPerBuyer);

				// Calculate rent needed for ticket balance and entry account
				const rentBase = provider.client.getRent();
				const rentNeeded = rentBase.minimumBalance(
					BigInt(
						raffleProgram.account.entry.size +
							raffleProgram.account.ticketBalance.size,
					),
				);

				// Mint rent needed + balance to purchase ticket + 0.1 SOL for fees
				const totalTicketsPrice = amountToPurchase.mul(ticketPrice);
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
					.buyTickets(amountToPurchase, Array.from(entrySeed))
					.accounts({
						signer: buyer.publicKey,
						raffle: new PublicKey(raffleAccountId),
					})
					.signers([buyer])
					.rpc();
			}

			// Draw winning ticket. Should work because all tickets have been sold
			await raffleProgram.methods
				.drawWinningTicket()
				.accounts({
					raffle: new PublicKey(raffleAccountId),
					recentSlothashes: new PublicKey(
						"SysvarS1otHashes111111111111111111111111111",
					),
				})
				.rpc();

			// Validate the raffle state
			const raffleAccount =
				await raffleProgram.account.raffle.fetch(raffleAccountId);

			expect(raffleAccount.raffleState.drawing).toBeDefined();
			expect(raffleAccount.raffleState.open).toBeUndefined();
			expect(raffleAccount.raffleState.drawn).toBeUndefined();
			expect(raffleAccount.raffleState.expired).toBeUndefined();
			expect(raffleAccount.raffleState.claimed).toBeUndefined();
			expect(raffleAccount.winningTicket).toBeDefined();

			const totalTickets = input.numBuyers * input.ticketsPerBuyer;
			expect(raffleAccount.winningTicket?.lt(new BN(totalTickets))).toBeTrue();
			expect(raffleAccount.winningTicket?.gte(new BN(0))).toBeTrue();
		}
	});

	it("should fail when the current raffle is not in open state", async () => {
		const client = fromWorkspace(".");
		client.withSysvars();
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
				upgradeAuthority: provider.publicKey,
			})
			.rpc();

		const nonOpenStates = ["expired", "drawn", "drawing", "claimed"];
		for (const state of nonOpenStates) {
			// Fetch config, so we can build the PDA
			const configId = PublicKey.findProgramAddressSync(
				[Buffer.from("config")],
				raffleProgram.programId,
			)[0];
			const config = await raffleProgram.account.config.fetch(configId);

			const creationTime = client.getClock().unixTimestamp;
			const metadataUri = "https://www.example.org";
			const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
			const minTickets = new BN(1);
			const endTime = new BN((creationTime + BigInt(3601)).toString());

			// Create raffle, so that defaults are set, PDAs are created, etc.
			await raffleProgram.methods
				.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
				.rpc();
			const raffleAccountId = PublicKey.findProgramAddressSync(
				[
					Buffer.from("raffle"),
					new Uint8Array(new BN(config.raffleCounter).toArray("le", 8)),
				],
				raffleProgram.programId,
			)[0];

			const treasuryId = PublicKey.findProgramAddressSync(
				[Buffer.from("treasury"), raffleAccountId.toBytes()],
				raffleProgram.programId,
			)[0];

			const amountToPurchase = new BN(1);
			const buyer = new Keypair();
			const rentBase = provider.client.getRent();
			const rentNeeded = rentBase.minimumBalance(
				BigInt(
					raffleProgram.account.entry.size +
						raffleProgram.account.ticketBalance.size,
				),
			);

			// Mint rent needed + balance to purchase ticket + 0.1 SOL for fees
			const totalTicketsPrice = amountToPurchase.mul(ticketPrice);
			provider.client.airdrop(
				buyer.publicKey,
				BigInt(
					totalTicketsPrice
						.add(new BN(rentNeeded.toString()))
						.add(new BN(0.1 * LAMPORTS_PER_SOL))
						.toString(),
				),
			);

			// Init ticket balance before setting the raffle into an non-open state
			await raffleProgram.methods
				.initTicketBalance()
				.accounts({
					signer: buyer.publicKey,
					raffle: raffleAccountId,
				})
				.signers([buyer])
				.rpc();

			// Manually set the raffle and treasury accounts
			const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
				metadataUri,
				ticketPrice,
				minTickets,
				endTime,
				treasury: treasuryId,
				currentTickets: new BN(1000),
				creationTime: new BN(0),
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

			expect(
				raffleProgram.methods
					.drawWinningTicket()
					.accounts({
						raffle: raffleAccountId,
						recentSlothashes: new PublicKey(
							"SysvarS1otHashes111111111111111111111111111",
						),
					})
					.rpc(),
			).rejects.toThrow(/RaffleNotOpen/);
		}
	});

	it("should fail when the current raffle has not yet ended", async () => {
		const client = fromWorkspace(".");
		client.withSysvars();
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
				upgradeAuthority: provider.publicKey,
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

		const buyer = new Keypair();
		const amountToPurchase = minTickets;

		// Calculate rent needed for ticket balance and entry account
		const rentBase = provider.client.getRent();
		const rentNeeded = rentBase.minimumBalance(
			BigInt(
				raffleProgram.account.entry.size +
					raffleProgram.account.ticketBalance.size,
			),
		);

		// Mint rent needed + balance to purchase ticket + 0.1 SOL for fees
		const totalTicketsPrice = amountToPurchase.mul(ticketPrice);
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
			.buyTickets(amountToPurchase, Array.from(entrySeed))
			.accounts({
				signer: buyer.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer])
			.rpc();

		// Draw winning ticket
		expect(
			raffleProgram.methods
				.drawWinningTicket()
				.accounts({
					raffle: new PublicKey(raffleAccountId),
					recentSlothashes: new PublicKey(
						"SysvarS1otHashes111111111111111111111111111",
					),
				})
				.rpc(),
		).rejects.toThrow(/RaffleNotEnded/);
	});

	it("should fail when a raffle has not met the threshold", async () => {
		const client = fromWorkspace(".");
		client.withSysvars();
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
				upgradeAuthority: provider.publicKey,
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

		// Set time so that the raffle has ended
		const newClock = client.getClock();
		newClock.unixTimestamp = creationTime + BigInt(3601);
		client.setClock(newClock);

		// Draw winning ticket
		expect(
			raffleProgram.methods
				.drawWinningTicket()
				.accounts({
					raffle: new PublicKey(raffleAccountId),
					recentSlothashes: new PublicKey(
						"SysvarS1otHashes111111111111111111111111111",
					),
				})
				.rpc(),
		).rejects.toThrow(/InsufficientTickets/);
	});

	it("should fail when a raffle with a maximum ticket amount has not met the threshold", async () => {
		const client = fromWorkspace(".");
		client.withSysvars();
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
				upgradeAuthority: provider.publicKey,
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

		// Set time so that the raffle has ended
		const newClock = client.getClock();
		newClock.unixTimestamp = creationTime + BigInt(3601);
		client.setClock(newClock);

		// Draw winning ticket
		expect(
			raffleProgram.methods
				.drawWinningTicket()
				.accounts({
					raffle: new PublicKey(raffleAccountId),
					recentSlothashes: new PublicKey(
						"SysvarS1otHashes111111111111111111111111111",
					),
				})
				.rpc(),
		).rejects.toThrow(/InsufficientTickets/);
	});

	it("should fail with an invalid slothashes account", async () => {
		const client = fromWorkspace(".");
		client.withSysvars();
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
				upgradeAuthority: provider.publicKey,
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

		const buyer = new Keypair();
		const amountToPurchase = minTickets;

		// Calculate rent needed for ticket balance and entry account
		const rentBase = provider.client.getRent();
		const rentNeeded = rentBase.minimumBalance(
			BigInt(
				raffleProgram.account.entry.size +
					raffleProgram.account.ticketBalance.size,
			),
		);

		// Mint rent needed + balance to purchase ticket + 0.1 SOL for fees
		const totalTicketsPrice = amountToPurchase.mul(ticketPrice);
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
			.buyTickets(amountToPurchase, Array.from(entrySeed))
			.accounts({
				signer: buyer.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer])
			.rpc();

		// Set time so that the raffle has ended
		const newClock = client.getClock();
		newClock.unixTimestamp = creationTime + BigInt(3601);
		client.setClock(newClock);

		const malformedAccounts = [
			"SysvarS1otHistory11111111111111111111111111",
			"SysvarStakeHistory1111111111111111111111111",
			"SysvarC1ock11111111111111111111111111111111",
			"11111111111111111111111111111111",
			new Keypair().publicKey,
		];
		for (const malformedAccount of malformedAccounts) {
			// Draw winning ticket
			expect(
				raffleProgram.methods
					.drawWinningTicket()
					.accounts({
						raffle: new PublicKey(raffleAccountId),
						recentSlothashes: new PublicKey(malformedAccount),
					})
					.rpc(),
			).rejects.toThrow(/InvalidSlotHashesAccount/);
		}
	});
});
