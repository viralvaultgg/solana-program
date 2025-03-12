import { describe, expect, it } from "bun:test";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { LiteSVMProvider, fromWorkspace } from "anchor-litesvm";
import type { RaffleProgram } from "../target/types/raffle_program";
const IDL = require("../target/idl/raffle_program.json");

describe("buy_tickets", async () => {
	it("should successfully purchase tickets for an open raffle with sufficient funds", async () => {
		const client = fromWorkspace(".");
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
		const minTickets = new BN(1);
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
		let treasuryBalance = provider.client.getBalance(treasuryId);
		if (!treasuryBalance) {
			throw new Error("Treasury balance is null");
		}

		const firstBuyer = new Keypair();

		// Airdrop some more to the first buyer, because LiteSVM seems
		// to have some issue when airdropping to the same wallet multiple times
		provider.client.airdrop(
			firstBuyer.publicKey,
			BigInt(20 * LAMPORTS_PER_SOL),
		);

		const inputs: {
			buyer: Keypair;
			ticketAmount: number;
		}[] = [
			{
				buyer: firstBuyer,
				ticketAmount: 1,
			},
			{
				buyer: new Keypair(),
				ticketAmount: 5,
			},
			{
				buyer: firstBuyer,
				ticketAmount: 5,
			},
			{
				buyer: firstBuyer,
				ticketAmount: 5,
			},
		];

		for (const input of inputs) {
			// Fetch the raffle account to get the previous ticket counts
			const buyer = input.buyer;
			const amountToPurchase = new BN(input.ticketAmount);

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

			let raffleAccount =
				await raffleProgram.account.raffle.fetch(raffleAccountId);
			const previousTickets = raffleAccount.currentTickets;

			// Create ticket balance, if not yet exists
			const ticketBalanceId = PublicKey.findProgramAddressSync(
				[
					Buffer.from("ticket_balance"),
					raffleAccountId.toBytes(),
					buyer.publicKey.toBytes(),
				],
				raffleProgram.programId,
			)[0];

			let previousTicketBalance = 0;
			try {
				const ticketBalanceAccount =
					await raffleProgram.account.ticketBalance.fetch(ticketBalanceId);
				previousTicketBalance = ticketBalanceAccount.ticketCount.toNumber();
			} catch (err) {
				if (err instanceof Error && err.message.includes("Could not find")) {
					await raffleProgram.methods
						.initTicketBalance()
						.accounts({
							signer: buyer.publicKey,
							raffle: new PublicKey(raffleAccountId),
						})
						.signers([buyer])
						.rpc();
				}
			}

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

			// Validate entry
			const entryId = PublicKey.findProgramAddressSync(
				[Buffer.from("entry"), raffleAccountId.toBytes(), entrySeed],
				raffleProgram.programId,
			)[0];
			const entryAccount = await raffleProgram.account.entry.fetch(entryId);
			expect(entryAccount.raffle.equals(raffleAccountId)).toBeTrue();
			expect(entryAccount.owner.equals(buyer.publicKey)).toBeTrue();
			expect(entryAccount.seed).toEqual(Array.from(entrySeed));
			expect(entryAccount.ticketCount.eq(amountToPurchase)).toBeTrue();
			expect(entryAccount.ticketStartIndex.eq(previousTickets)).toBeTrue();

			// Validate ticket balance
			const ticketBalanceAccount =
				await raffleProgram.account.ticketBalance.fetch(ticketBalanceId);
			expect(
				ticketBalanceAccount.ticketCount.eq(
					new BN(previousTicketBalance).add(amountToPurchase),
				),
			).toBeTrue();

			// Validate raffle changes
			raffleAccount = await raffleProgram.account.raffle.fetch(raffleAccountId);
			expect(
				raffleAccount.currentTickets.eq(previousTickets.add(amountToPurchase)),
			).toBeTrue();

			// Validate treasury changes
			const oldTreasuryBalance = new BN(treasuryBalance.toString());
			treasuryBalance = provider.client.getBalance(treasuryId);
			if (!treasuryBalance) {
				throw new Error("Treasury balance is null");
			}

			expect(
				new BN(treasuryBalance.toString())
					.sub(oldTreasuryBalance)
					.eq(totalTicketsPrice),
			).toBeTrue();
		}
	});

	it("should successfully allow purchasing the last ticket before the maximum threshold", async () => {
		const client = fromWorkspace(".");
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

		// Fetch config, so we can build the PDA
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const config = await raffleProgram.account.config.fetch(configId);

		const inputs: {
			minTickets: number;
			maxTickets: number;
			ticketCountBeforePurchase: number;
			ticketsToPurchase: number;
		}[] = [
			{
				minTickets: 1,
				maxTickets: 10,
				ticketCountBeforePurchase: 1,
				ticketsToPurchase: 1,
			},
			{
				minTickets: 1,
				maxTickets: 10,
				ticketCountBeforePurchase: 9,
				ticketsToPurchase: 1,
			},
			{
				minTickets: 1,
				maxTickets: 10,
				ticketCountBeforePurchase: 0,
				ticketsToPurchase: 10,
			},
		];

		for (const input of inputs) {
			const creationTime = client.getClock().unixTimestamp;
			const metadataUri = "https://www.example.org";
			const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
			const minTickets = new BN(input.minTickets);
			const maxTickets = new BN(input.maxTickets);
			const endTime = new BN((creationTime + BigInt(3601)).toString());

			// Create raffle, so that defaults are set, PDAs are created, etc.
			await raffleProgram.methods
				.createRaffle(metadataUri, ticketPrice, endTime, minTickets, maxTickets)
				.rpc();
			const raffleAccountId = PublicKey.findProgramAddressSync(
				[
					Buffer.from("raffle"),
					new Uint8Array(new BN(config.raffleCounter).toArray("le", 8)),
				],
				raffleProgram.programId,
			)[0];

			const amountToPurchase = new BN(input.ticketsToPurchase);
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

			// Manually set the raffle account
			const oldRaffleData =
				await raffleProgram.account.raffle.fetch(raffleAccountId);
			const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
				...oldRaffleData,
				currentTickets: new BN(input.ticketCountBeforePurchase),
			});
			provider.client.setAccount(raffleAccountId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: raffleData,
			});

			const randomBytes = new Uint8Array(8);
			crypto.getRandomValues(randomBytes);
			const entrySeed = randomBytes;

			// Purchase the last ticket
			await raffleProgram.methods
				.buyTickets(amountToPurchase, Array.from(entrySeed))
				.accounts({
					raffle: raffleAccountId,
					signer: buyer.publicKey,
				})
				.signers([buyer])
				.rpc();

			// Validate that the ticket count is exactly the initial + the bought ticket amount
			const raffleAccount =
				await raffleProgram.account.raffle.fetch(raffleAccountId);
			expect(
				raffleAccount.currentTickets.eq(
					new BN(input.ticketCountBeforePurchase + input.ticketsToPurchase),
				),
			).toBeTrue();
		}
	});

	it("should fail when attempting to purchase a ticket after the maximum threshold has been reached", async () => {
		const client = fromWorkspace(".");
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
		const maxTickets = new BN(10);
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		// Create raffle, so that defaults are set, PDAs are created, etc.
		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, maxTickets)
			.rpc();
		const raffleAccountId = PublicKey.findProgramAddressSync(
			[
				Buffer.from("raffle"),
				new Uint8Array(new BN(config.raffleCounter).toArray("le", 8)),
			],
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

		// Manually set the raffle account
		const oldRaffleData =
			await raffleProgram.account.raffle.fetch(raffleAccountId);
		const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
			...oldRaffleData,
			currentTickets: maxTickets,
		});
		provider.client.setAccount(raffleAccountId, {
			executable: false,
			owner: raffleProgram.programId,
			lamports: 1 * LAMPORTS_PER_SOL,
			data: raffleData,
		});

		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		expect(
			raffleProgram.methods
				.buyTickets(amountToPurchase, Array.from(entrySeed))
				.accounts({
					raffle: raffleAccountId,
					signer: buyer.publicKey,
				})
				.signers([buyer])
				.rpc(),
		).rejects.toThrow(/MaximumTicketsSold/);
	});

	it("should fail when purchasing an amount of tickets would exceed the maximum threshold", async () => {
		const client = fromWorkspace(".");
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
		const maxTickets = new BN(10);
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		// Create raffle, so that defaults are set, PDAs are created, etc.
		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, maxTickets)
			.rpc();
		const raffleAccountId = PublicKey.findProgramAddressSync(
			[
				Buffer.from("raffle"),
				new Uint8Array(new BN(config.raffleCounter).toArray("le", 8)),
			],
			raffleProgram.programId,
		)[0];

		const amountToPurchase = new BN(2);
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

		// Manually set the raffle account
		const oldRaffleData =
			await raffleProgram.account.raffle.fetch(raffleAccountId);
		const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
			...oldRaffleData,
			currentTickets: maxTickets.sub(new BN(1)),
		});
		provider.client.setAccount(raffleAccountId, {
			executable: false,
			owner: raffleProgram.programId,
			lamports: 1 * LAMPORTS_PER_SOL,
			data: raffleData,
		});

		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		expect(
			raffleProgram.methods
				.buyTickets(amountToPurchase, Array.from(entrySeed))
				.accounts({
					raffle: raffleAccountId,
					signer: buyer.publicKey,
				})
				.signers([buyer])
				.rpc(),
		).rejects.toThrow(/PurchaseExceedsThreshold/);
	});

	it("should fail when attempting to purchase zero tickets", async () => {
		const client = fromWorkspace(".");
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
		const minTickets = new BN(1);
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

		// Fetch the raffle account to get the previous ticket counts
		const buyer = new Keypair();
		const amountToPurchase = new BN(0);

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

		// Purchase tickets, should fail since we are purchasing 0 tickets
		expect(
			raffleProgram.methods
				.buyTickets(amountToPurchase, Array.from(entrySeed))
				.accounts({
					signer: buyer.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([buyer])
				.rpc(),
		).rejects.toThrow(/InvalidTicketCount/);
	});

	it("should fail when attempting to purchase on a raffle that is not open", async () => {
		const client = fromWorkspace(".");
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

			// Technically it is not possible to have any other raffle state than "OPEN" when the end time
			// has not passed, but we still want to test this constraint. We have to set the end time
			// to something in the future, because otherwise the "RaffleEnded" constraint would come in.
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
				currentTickets: new BN(0),
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

			const randomBytes = new Uint8Array(8);
			crypto.getRandomValues(randomBytes);
			const entrySeed = randomBytes;

			expect(
				raffleProgram.methods
					.buyTickets(amountToPurchase, Array.from(entrySeed))
					.accounts({
						raffle: raffleAccountId,
						signer: buyer.publicKey,
					})
					.signers([buyer])
					.rpc(),
			).rejects.toThrow(/RaffleNotOpen/);
		}
	});

	it("should fail when attempting to purchase on an open raffle that has ended", async () => {
		const client = fromWorkspace(".");
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
			endTime: new BN((creationTime - BigInt(3600)).toString()), // Update endTime to something that is in the past
			treasury: treasuryId,
			currentTickets: new BN(0),
			creationTime: new BN(0),
			raffleState: {
				open: {},
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

		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		expect(
			raffleProgram.methods
				.buyTickets(amountToPurchase, Array.from(entrySeed))
				.accounts({
					raffle: raffleAccountId,
					signer: buyer.publicKey,
				})
				.signers([buyer])
				.rpc(),
		).rejects.toThrow(/RaffleEnded/);
	});

	it("should fail with InsufficientFunds error when buyer does not have enough SOL to cover ticket price", async () => {
		const client = fromWorkspace(".");
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
		const minTickets = new BN(1);
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
		const amountToPurchase = new BN(10);

		// Calculate rent needed for ticket balance and entry account
		const rentBase = provider.client.getRent();
		const rentNeeded = rentBase.minimumBalance(
			BigInt(
				raffleProgram.account.entry.size +
					raffleProgram.account.ticketBalance.size,
			),
		);

		// Mint rent needed + 0.1 SOL for fees
		provider.client.airdrop(
			buyer.publicKey,
			BigInt(
				new BN(rentNeeded.toString())
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

		// Purchase tickets
		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		expect(
			raffleProgram.methods
				.buyTickets(amountToPurchase, Array.from(entrySeed))
				.accounts({
					signer: buyer.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([buyer])
				.rpc(),
		).rejects.toThrow(/InsufficientFunds/);
	});

	it("should fail when submitted treasury account does not belong to the raffle", async () => {
		const client = fromWorkspace(".");
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

		// Create a raffle, so that a treasury gets created. We will use this treasury later
		const creationTime = client.getClock().unixTimestamp;
		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(1);
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
			.rpc();
		const raffleAccountId = PublicKey.findProgramAddressSync(
			[Buffer.from("raffle"), new Uint8Array(new BN(0).toArray("le", 8))],
			raffleProgram.programId,
		)[0];
		const treasuryId = PublicKey.findProgramAddressSync(
			[Buffer.from("treasury"), raffleAccountId.toBytes()],
			raffleProgram.programId,
		)[0];

		const inputs: {
			treasury: PublicKey;
			errorRegex: RegExp;
		}[] = [
			{
				// Just a random keypair that does not exist
				treasury: new Keypair().publicKey,
				errorRegex: /AccountNotInitialized/,
			},
			{
				// Here, we take a treasury from another raffle
				treasury: treasuryId,
				errorRegex: /ConstraintSeeds/,
			},
			{
				// Here, we use a completely different account from this program
				treasury: raffleAccountId,
				errorRegex: /AccountDiscriminatorMismatch/,
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
			const minTickets = new BN(1);
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
			const amountToPurchase = new BN(10);

			// Calculate rent needed for ticket balance and entry account
			const rentBase = provider.client.getRent();
			const rentNeeded = rentBase.minimumBalance(
				BigInt(
					raffleProgram.account.entry.size +
						raffleProgram.account.ticketBalance.size,
				),
			);

			// Mint rent needed + 0.1 SOL for fees
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

			// Purchase tickets
			const randomBytes = new Uint8Array(8);
			crypto.getRandomValues(randomBytes);
			const entrySeed = randomBytes;

			expect(
				raffleProgram.methods
					.buyTickets(amountToPurchase, Array.from(entrySeed))
					.accountsPartial({
						signer: buyer.publicKey,
						raffle: new PublicKey(raffleAccountId),
						treasury: input.treasury,
					})
					.signers([buyer])
					.rpc(),
			).rejects.toThrow(input.errorRegex);
		}
	});

	it("should fail when the signer has no ticket_balance for the given raffle", async () => {
		const client = fromWorkspace(".");
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

		// Create a raffle, so that a treasury gets created. We will use this treasury later
		const creationTime = client.getClock().unixTimestamp;
		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(1);
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
			.rpc();
		const raffleAccountId = PublicKey.findProgramAddressSync(
			[Buffer.from("raffle"), new Uint8Array(new BN(0).toArray("le", 8))],
			raffleProgram.programId,
		)[0];

		const buyer = new Keypair();
		const amountToPurchase = new BN(10);

		// Calculate rent needed for ticket balance and entry account
		const rentBase = provider.client.getRent();
		const rentNeeded = rentBase.minimumBalance(
			BigInt(
				raffleProgram.account.entry.size +
					raffleProgram.account.ticketBalance.size,
			),
		);

		// Mint rent needed + 0.1 SOL for fees
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

		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		expect(
			raffleProgram.methods
				.buyTickets(amountToPurchase, Array.from(entrySeed))
				.accounts({
					signer: buyer.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([buyer])
				.rpc(),
		).rejects.toThrow(/AccountNotInitialized/);
	});

	it("should fail when trying to purchase with an entry seed that already exists", async () => {
		const client = fromWorkspace(".");
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
		const minTickets = new BN(1);
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

		// Fetch the raffle account to get the previous ticket counts
		const buyer = new Keypair();
		const amountToPurchase = new BN(10);

		// Calculate rent needed for ticket balance and entry account
		const rentBase = provider.client.getRent();
		const rentNeeded = rentBase.minimumBalance(
			BigInt(
				raffleProgram.account.entry.size +
					raffleProgram.account.ticketBalance.size,
			),
		);

		// Mint rent needed + 2*(balance to purchase ticket) + 0.1 SOL for fees
		const totalTicketsPrice = amountToPurchase.mul(new BN(2)).mul(ticketPrice);
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

		// Purchase tickets. This should succeed as it's the first time
		await raffleProgram.methods
			.buyTickets(amountToPurchase, Array.from(entrySeed))
			.accounts({
				signer: buyer.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer])
			.rpc();

		// We need to change the amountToPurchase here, because otherwise the transaction gets rejected.
		// I think this is because if we don't change this, we send two transactions with the same signature.
		expect(
			raffleProgram.methods
				.buyTickets(new BN(1), Array.from(entrySeed))
				.accounts({
					signer: buyer.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([buyer])
				.rpc(),
		).rejects.toThrow(/already in use/);
	});

	it("should fail when trying to use a ticket_balance that is not associated with the signer", async () => {
		const client = fromWorkspace(".");
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
		const minTickets = new BN(1);
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

		// Fetch the raffle account to get the previous ticket counts
		const buyer = new Keypair();
		const amountToPurchase = new BN(10);

		// Calculate rent needed for ticket balance and entry account
		const rentBase = provider.client.getRent();
		const rentNeeded = rentBase.minimumBalance(
			BigInt(
				raffleProgram.account.entry.size +
					raffleProgram.account.ticketBalance.size,
			),
		);

		// Mint rent needed + 2*(balance to purchase ticket) + 0.1 SOL for fees
		const totalTicketsPrice = amountToPurchase.mul(new BN(2)).mul(ticketPrice);
		provider.client.airdrop(
			buyer.publicKey,
			BigInt(
				totalTicketsPrice
					.add(new BN(rentNeeded.toString()))
					.add(new BN(0.1 * LAMPORTS_PER_SOL))
					.toString(),
			),
		);

		// Create ticket balance, but for a different buyer
		const diffBuyer = new Keypair();
		provider.client.airdrop(diffBuyer.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				signer: diffBuyer.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([diffBuyer])
			.rpc();

		// Get the ticket_balance id
		const ticketBalanceId = PublicKey.findProgramAddressSync(
			[
				Buffer.from("ticket_balance"),
				raffleAccountId.toBytes(),
				diffBuyer.publicKey.toBytes(),
			],
			raffleProgram.programId,
		)[0];

		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		// Purchase tickets, should fail because we are using someone else's ticket balance here
		expect(
			raffleProgram.methods
				.buyTickets(amountToPurchase, Array.from(entrySeed))
				.accountsPartial({
					ticketBalance: ticketBalanceId,
					signer: buyer.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([buyer])
				.rpc(),
		).rejects.toThrow(/ConstraintSeeds/);
	});
});
