import { describe, expect, it } from "bun:test";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { LiteSVMProvider, fromWorkspace } from "anchor-litesvm";
import type { RaffleProgram } from "../target/types/raffle_program";
const IDL = require("../target/idl/raffle_program.json");

describe("reclaim_expired_tickets", async () => {
	it("should successfully reclaim funds for tickets purchased in an expired raffle", async () => {
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

		// Define test cases with different ticket amounts
		const testCases = [
			{ ticketAmount: 1, description: "single ticket" },
			{ ticketAmount: 5, description: "multiple tickets" },
			{ ticketAmount: 100, description: "large number of tickets" },
		];

		for (const testCase of testCases) {
			// Fetch config before creating raffle
			const configId = PublicKey.findProgramAddressSync(
				[Buffer.from("config")],
				raffleProgram.programId,
			)[0];
			const config = await raffleProgram.account.config.fetch(configId);
			const creationTime = client.getClock().unixTimestamp;
			const initialRaffleCounter = config.raffleCounter;

			const metadataUri = "https://www.example.org";
			const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
			const minTickets = new BN(testCase.ticketAmount + 1); // Set min tickets higher to ensure raffle will expire
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

			// Create buyer and fund their account
			const buyer = new Keypair();
			const ticketsToPurchase = new BN(testCase.ticketAmount);
			const totalTicketsPrice = ticketsToPurchase.mul(ticketPrice);

			// Calculate rent needed for ticket balance and entry account
			const rentBase = provider.client.getRent();
			const rentNeeded = rentBase.minimumBalance(
				BigInt(
					raffleProgram.account.entry.size +
						raffleProgram.account.ticketBalance.size,
				),
			);

			provider.client.airdrop(
				buyer.publicKey,
				BigInt(
					totalTicketsPrice
						.add(new BN(rentNeeded.toString()))
						.add(new BN(0.1 * LAMPORTS_PER_SOL))
						.toString(),
				),
			);

			// Initialize ticket balance
			await raffleProgram.methods
				.initTicketBalance()
				.accounts({
					signer: buyer.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([buyer])
				.rpc();

			// Generate random seed for entry
			const randomBytes = new Uint8Array(8);
			crypto.getRandomValues(randomBytes);
			const entrySeed = randomBytes;

			// Purchase tickets
			await raffleProgram.methods
				.buyTickets(ticketsToPurchase, Array.from(entrySeed))
				.accounts({
					signer: buyer.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([buyer])
				.rpc();

			// Confirm ticket purchase
			const ticketBalanceId = PublicKey.findProgramAddressSync(
				[
					Buffer.from("ticket_balance"),
					raffleAccountId.toBytes(),
					buyer.publicKey.toBytes(),
				],
				raffleProgram.programId,
			)[0];

			const ticketBalanceAccount =
				await raffleProgram.account.ticketBalance.fetch(ticketBalanceId);
			expect(ticketBalanceAccount.ticketCount.eq(ticketsToPurchase)).toBeTrue();

			// Time-travel to when the raffle ends
			const newClock = client.getClock();
			newClock.unixTimestamp = creationTime + BigInt(3602);
			client.setClock(newClock);

			// Expire the raffle
			await raffleProgram.methods
				.expireRaffle()
				.accounts({ raffle: raffleAccountId })
				.rpc();

			// Verify raffle is expired
			const raffleAccount =
				await raffleProgram.account.raffle.fetch(raffleAccountId);
			expect(raffleAccount.raffleState.expired).toBeDefined();

			// Get balances before reclaim
			const buyerBalanceBefore = provider.client.getBalance(buyer.publicKey);
			const treasuryBalanceBefore = provider.client.getBalance(treasuryId);
			if (!buyerBalanceBefore || !treasuryBalanceBefore) {
				throw new Error("Failed to get balance");
			}

			// Reclaim expired tickets
			await raffleProgram.methods
				.reclaimExpiredTickets()
				.accounts({
					signer: buyer.publicKey,
					raffle: raffleAccountId,
				})
				.signers([buyer])
				.rpc();

			// Get balances after reclaim
			const buyerBalanceAfter = provider.client.getBalance(buyer.publicKey);
			const treasuryBalanceAfter = provider.client.getBalance(treasuryId);
			if (!buyerBalanceAfter || !treasuryBalanceAfter) {
				throw new Error("Failed to get balance");
			}

			// Expected refund amount
			const expectedRefund = totalTicketsPrice.toNumber();

			// Verify funds were transferred correctly
			expect(buyerBalanceAfter - buyerBalanceBefore).toBeGreaterThan(
				expectedRefund,
			); // Greater than because of rent refund

			expect(treasuryBalanceBefore - treasuryBalanceAfter).toBe(
				BigInt(expectedRefund),
			);

			// Verify ticket balance account is closed (should throw)
			expect(
				raffleProgram.account.ticketBalance.fetch(ticketBalanceId),
			).rejects.toThrow(/Account does not exist/);
		}
	});

	it("should successfully reclaim funds when multiple users have purchased tickets in the expired raffle", async () => {
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

		// Fetch config before creating raffle
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const config = await raffleProgram.account.config.fetch(configId);
		const creationTime = client.getClock().unixTimestamp;
		const initialRaffleCounter = config.raffleCounter;

		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(15); // Set min tickets higher to ensure raffle will expire
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

		// Create multiple buyers
		const buyer1 = new Keypair();
		const buyer2 = new Keypair();
		const ticketsToPurchase1 = new BN(5);
		const ticketsToPurchase2 = new BN(3);

		// Calculate total ticket prices
		const totalTicketsPrice1 = ticketsToPurchase1.mul(ticketPrice);
		const totalTicketsPrice2 = ticketsToPurchase2.mul(ticketPrice);

		// Calculate rent needed
		const rentBase = provider.client.getRent();
		const rentNeeded = rentBase.minimumBalance(
			BigInt(
				raffleProgram.account.entry.size +
					raffleProgram.account.ticketBalance.size,
			),
		);

		// Fund both buyers
		provider.client.airdrop(
			buyer1.publicKey,
			BigInt(
				totalTicketsPrice1
					.add(new BN(rentNeeded.toString()))
					.add(new BN(0.1 * LAMPORTS_PER_SOL))
					.toString(),
			),
		);

		provider.client.airdrop(
			buyer2.publicKey,
			BigInt(
				totalTicketsPrice2
					.add(new BN(rentNeeded.toString()))
					.add(new BN(0.1 * LAMPORTS_PER_SOL))
					.toString(),
			),
		);

		// Initialize ticket balances for both buyers
		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				signer: buyer1.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer1])
			.rpc();

		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				signer: buyer2.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer2])
			.rpc();

		// Generate random seeds for entries
		const randomBytes1 = new Uint8Array(8);
		crypto.getRandomValues(randomBytes1);
		const entrySeed1 = randomBytes1;

		const randomBytes2 = new Uint8Array(8);
		crypto.getRandomValues(randomBytes2);
		const entrySeed2 = randomBytes2;

		// Both buyers purchase tickets
		await raffleProgram.methods
			.buyTickets(ticketsToPurchase1, Array.from(entrySeed1))
			.accounts({
				signer: buyer1.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer1])
			.rpc();

		await raffleProgram.methods
			.buyTickets(ticketsToPurchase2, Array.from(entrySeed2))
			.accounts({
				signer: buyer2.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer2])
			.rpc();

		// Time-travel to when the raffle ends
		const newClock = client.getClock();
		newClock.unixTimestamp = creationTime + BigInt(3602);
		client.setClock(newClock);

		// Expire the raffle
		await raffleProgram.methods
			.expireRaffle()
			.accounts({ raffle: raffleAccountId })
			.rpc();

		// Get balances before reclaim
		const buyer1BalanceBefore = provider.client.getBalance(buyer1.publicKey);
		const buyer2BalanceBefore = provider.client.getBalance(buyer2.publicKey);
		const treasuryBalanceBefore = provider.client.getBalance(treasuryId);

		// Both buyers reclaim their expired tickets
		await raffleProgram.methods
			.reclaimExpiredTickets()
			.accounts({
				signer: buyer1.publicKey,
				raffle: raffleAccountId,
			})
			.signers([buyer1])
			.rpc();

		// Get intermediate treasury balance
		const treasuryBalanceIntermediate = provider.client.getBalance(treasuryId);

		await raffleProgram.methods
			.reclaimExpiredTickets()
			.accounts({
				signer: buyer2.publicKey,
				raffle: raffleAccountId,
			})
			.signers([buyer2])
			.rpc();

		// Get balances after reclaim
		const buyer1BalanceAfter = provider.client.getBalance(buyer1.publicKey);
		const buyer2BalanceAfter = provider.client.getBalance(buyer2.publicKey);
		const treasuryBalanceAfter = provider.client.getBalance(treasuryId);

		// Expected refund amounts
		const expectedRefund1 = totalTicketsPrice1.toNumber();
		const expectedRefund2 = totalTicketsPrice2.toNumber();

		// Verify funds were transferred correctly for both buyers
		expect(
			Number(buyer1BalanceAfter) - Number(buyer1BalanceBefore),
		).toBeGreaterThan(expectedRefund1);

		expect(
			Number(buyer2BalanceAfter) - Number(buyer2BalanceBefore),
		).toBeGreaterThan(expectedRefund2);

		expect(
			Number(treasuryBalanceBefore) - Number(treasuryBalanceIntermediate),
		).toBe(expectedRefund1);

		expect(
			Number(treasuryBalanceIntermediate) - Number(treasuryBalanceAfter),
		).toBe(expectedRefund2);
	});

	it("should fail for a raffle not in Expired state", async () => {
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

		const nonExpiredStates = ["open", "drawn", "drawing", "claimed"];
		for (const state of nonExpiredStates) {
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

			// Create buyer and initialize ticket balance
			const buyer = new Keypair();
			provider.client.airdrop(buyer.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

			await raffleProgram.methods
				.initTicketBalance()
				.accounts({
					signer: buyer.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([buyer])
				.rpc();

			// Manually set the raffle and treasury accounts
			const oldRaffleData =
				await raffleProgram.account.raffle.fetch(raffleAccountId);
			const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
				...oldRaffleData,
				raffleState: {
					[state]: {},
				},
			});
			provider.client.setAccount(raffleAccountId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: raffleData,
			});

			// Set a ticket in the ticket balance account
			const [ticketBalanceId, ticketBalanceBump] =
				PublicKey.findProgramAddressSync(
					[
						Buffer.from("ticket_balance"),
						raffleAccountId.toBytes(),
						buyer.publicKey.toBytes(),
					],
					raffleProgram.programId,
				);
			const ticketBalanceData = await raffleProgram.coder.accounts.encode(
				"ticketBalance",
				{
					owner: buyer.publicKey,
					ticketCount: new BN(1),
					bump: ticketBalanceBump,
				},
			);
			provider.client.setAccount(ticketBalanceId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: ticketBalanceData,
			});

			// Try to reclaim tickets - should fail
			expect(
				raffleProgram.methods
					.reclaimExpiredTickets()
					.accounts({
						signer: buyer.publicKey,
						raffle: raffleAccountId,
					})
					.signers([buyer])
					.rpc(),
			).rejects.toThrow(/RaffleNotExpired/);
		}
	});

	it("should fail when attempting to reclaim tickets owned by another user", async () => {
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

		// Fetch config before creating raffle
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const config = await raffleProgram.account.config.fetch(configId);
		const creationTime = client.getClock().unixTimestamp;
		const initialRaffleCounter = config.raffleCounter;

		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(10); // Set min tickets higher to ensure raffle will expire
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

		// Create actual owner and unauthorized user
		const ticketOwner = new Keypair();
		const unauthorizedUser = new Keypair();
		const ticketsToProcess = new BN(2);

		// Fund both accounts
		provider.client.airdrop(
			ticketOwner.publicKey,
			BigInt(
				ticketsToProcess
					.mul(ticketPrice)
					.add(new BN(0.2 * LAMPORTS_PER_SOL))
					.toString(),
			),
		);

		provider.client.airdrop(
			unauthorizedUser.publicKey,
			BigInt(
				ticketsToProcess
					.mul(ticketPrice)
					.add(new BN(0.2 * LAMPORTS_PER_SOL))
					.toString(),
			),
		);

		// Initialize ticket balances
		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				signer: ticketOwner.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([ticketOwner])
			.rpc();

		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				signer: unauthorizedUser.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([unauthorizedUser])
			.rpc();

		// Generate random seed for entry
		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		// Owner purchases tickets
		await raffleProgram.methods
			.buyTickets(ticketsToProcess, Array.from(entrySeed))
			.accounts({
				signer: ticketOwner.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([ticketOwner])
			.rpc();

		// Alter the unauthorized user's ticket balance to point to the original owner
		// This should not be possible, since there's no way to alter the owner.
		// Furthermore, anchor validates the seed. However, we still test this
		// since it's a good practice.
		const unauthorizedTicketBalanceId = PublicKey.findProgramAddressSync(
			[
				Buffer.from("ticket_balance"),
				raffleAccountId.toBytes(),
				unauthorizedUser.publicKey.toBytes(),
			],
			raffleProgram.programId,
		)[0];
		const ticketBalance = await raffleProgram.account.ticketBalance.fetch(
			unauthorizedTicketBalanceId,
		);
		const ticketBalanceData = await raffleProgram.coder.accounts.encode(
			"ticketBalance",
			{
				...ticketBalance,
				owner: ticketOwner.publicKey,
			},
		);
		provider.client.setAccount(unauthorizedTicketBalanceId, {
			executable: false,
			owner: raffleProgram.programId,
			lamports: 1 * LAMPORTS_PER_SOL,
			data: ticketBalanceData,
		});

		// Time-travel to when the raffle ends
		const newClock = client.getClock();
		newClock.unixTimestamp = creationTime + BigInt(3602);
		client.setClock(newClock);

		// Expire the raffle
		await raffleProgram.methods
			.expireRaffle()
			.accounts({ raffle: raffleAccountId })
			.rpc();

		// Unauthorized user tries to reclaim owner's tickets - should fail
		expect(
			raffleProgram.methods
				.reclaimExpiredTickets()
				.accountsPartial({
					signer: unauthorizedUser.publicKey,
					raffle: raffleAccountId,
				})
				.signers([unauthorizedUser])
				.rpc(),
		).rejects.toThrow(/OwnerMismatch/);
	});

	it("should fail with an invalid treasury account", async () => {
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

		// Fetch config before creating raffle
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const config = await raffleProgram.account.config.fetch(configId);
		const creationTime = client.getClock().unixTimestamp;
		const initialRaffleCounter = config.raffleCounter;

		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(10); // Set min tickets higher to ensure raffle will expire
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		// Create first raffle (this will be the expired one)
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

		// Create second raffle (this will provide the incorrect treasury)
		await raffleProgram.methods
			.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
			.rpc();
		const secondRaffleAccountId = PublicKey.findProgramAddressSync(
			[
				Buffer.from("raffle"),
				new Uint8Array(
					new BN(initialRaffleCounter.add(new BN(1))).toArray("le", 8),
				),
			],
			raffleProgram.programId,
		)[0];

		// Get incorrect treasury from second raffle
		const incorrectTreasuryId = PublicKey.findProgramAddressSync(
			[Buffer.from("treasury"), secondRaffleAccountId.toBytes()],
			raffleProgram.programId,
		)[0];

		// Create buyer and fund their account
		const buyer = new Keypair();
		const ticketsToProcess = new BN(2);

		provider.client.airdrop(
			buyer.publicKey,
			BigInt(
				ticketsToProcess
					.mul(ticketPrice)
					.add(new BN(0.2 * LAMPORTS_PER_SOL))
					.toString(),
			),
		);

		// Initialize ticket balance for first raffle
		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				signer: buyer.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer])
			.rpc();

		// Generate random seed for entry
		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const entrySeed = randomBytes;

		// Buy tickets for first raffle
		await raffleProgram.methods
			.buyTickets(ticketsToProcess, Array.from(entrySeed))
			.accounts({
				signer: buyer.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer])
			.rpc();

		// Simulate altering the first raffle to somehow point to the second raffle's treasury
		// This won't happen on chain because the treasuries are derived from the raffle's ID and there's no way in the
		// program to change the treasury on a raffle. However, we still test this for good practice.
		const firstRaffleAccount =
			await raffleProgram.account.raffle.fetch(raffleAccountId);
		const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
			...firstRaffleAccount,
			treasury: incorrectTreasuryId,
		});
		provider.client.setAccount(raffleAccountId, {
			executable: false,
			owner: raffleProgram.programId,
			lamports: 1 * LAMPORTS_PER_SOL,
			data: raffleData,
		});

		// Time-travel to when the raffle ends
		const newClock = client.getClock();
		newClock.unixTimestamp = creationTime + BigInt(3602);
		client.setClock(newClock);

		// Expire the first raffle
		await raffleProgram.methods
			.expireRaffle()
			.accounts({ raffle: raffleAccountId })
			.rpc();

		// Try to reclaim - should fail because of treasury mismatch
		expect(
			raffleProgram.methods
				.reclaimExpiredTickets()
				.accountsPartial({
					signer: buyer.publicKey,
					raffle: raffleAccountId,
				})
				.signers([buyer])
				.rpc(),
		).rejects.toThrow(/InvalidTreasury/);
	});

	it("should fail when trying to reclaim with zero tickets owned", async () => {
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

		// Fetch config before creating raffle
		const configId = PublicKey.findProgramAddressSync(
			[Buffer.from("config")],
			raffleProgram.programId,
		)[0];
		const config = await raffleProgram.account.config.fetch(configId);
		const creationTime = client.getClock().unixTimestamp;
		const initialRaffleCounter = config.raffleCounter;

		const metadataUri = "https://www.example.org";
		const ticketPrice = new BN(0.1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(10); // Set min tickets higher to ensure raffle will expire
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

		// Create buyer and fund their account
		const buyer = new Keypair();

		provider.client.airdrop(buyer.publicKey, BigInt(0.2 * LAMPORTS_PER_SOL));

		// Initialize ticket balance for raffle but don't buy any tickets
		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				signer: buyer.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([buyer])
			.rpc();

		// Time-travel to when the raffle ends
		const newClock = client.getClock();
		newClock.unixTimestamp = creationTime + BigInt(3602);
		client.setClock(newClock);

		// Expire the raffle
		await raffleProgram.methods
			.expireRaffle()
			.accounts({ raffle: raffleAccountId })
			.rpc();

		// Try to reclaim tickets with zero tickets owned - should fail
		expect(
			raffleProgram.methods
				.reclaimExpiredTickets()
				.accounts({
					signer: buyer.publicKey,
					raffle: raffleAccountId,
				})
				.signers([buyer])
				.rpc(),
		).rejects.toThrow(/NoTicketsOwned/);
	});
});
