import { describe, expect, it } from "bun:test";
import { BN, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { LiteSVMProvider, fromWorkspace } from "anchor-litesvm";
import type { RaffleProgram } from "../target/types/raffle_program";
const IDL = require("../target/idl/raffle_program.json");

describe("set_winner", async () => {
	it("should successfully set the winner for a raffle in drawing state", async () => {
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
			winningTicket: number;
			entries: {
				isWinningEntry: boolean;
				keypair: Keypair;
				startTicket: number;
				ticketCount: number;
			}[];
		}[] = [
			{
				winningTicket: 0,
				entries: [
					{
						keypair: new Keypair(),
						startTicket: 0,
						ticketCount: 1,
						isWinningEntry: true,
					},
				],
			},
			{
				winningTicket: 0,
				entries: [
					{
						keypair: new Keypair(),
						startTicket: 0,
						ticketCount: 10,
						isWinningEntry: true,
					},
				],
			},
			{
				winningTicket: 99,
				entries: [
					{
						keypair: new Keypair(),
						startTicket: 99,
						ticketCount: 1,
						isWinningEntry: true,
					},
				],
			},
			{
				winningTicket: 50,
				entries: [
					{
						keypair: new Keypair(),
						startTicket: 25,
						ticketCount: 40,
						isWinningEntry: true,
					},
				],
			},
			{
				winningTicket: 1,
				entries: [
					{
						keypair: new Keypair(),
						startTicket: 0,
						ticketCount: 1,
						isWinningEntry: false,
					},
					{
						keypair: new Keypair(),
						startTicket: 1,
						ticketCount: 1,
						isWinningEntry: true,
					},
					{
						keypair: new Keypair(),
						startTicket: 2,
						ticketCount: 1,
						isWinningEntry: false,
					},
				],
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

			let totalTickets = 0;
			let winningSeed = new Uint8Array(8);
			for (const entry of input.entries) {
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
					entry.keypair.publicKey,
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
						signer: entry.keypair.publicKey,
						raffle: new PublicKey(raffleAccountId),
					})
					.signers([entry.keypair])
					.rpc();

				const randomBytes = new Uint8Array(8);
				crypto.getRandomValues(randomBytes);
				const entrySeed = randomBytes;

				// Manually create entry PDA
				const entryAccountId = PublicKey.findProgramAddressSync(
					[Buffer.from("entry"), raffleAccountId.toBytes(), entrySeed],
					raffleProgram.programId,
				)[0];

				const entryData = await raffleProgram.coder.accounts.encode("entry", {
					raffle: raffleAccountId,
					owner: entry.keypair.publicKey,
					ticketCount: new BN(entry.ticketCount),
					ticketStartIndex: new BN(entry.startTicket),
					seed: Array.from(entrySeed),
				});
				provider.client.setAccount(entryAccountId, {
					executable: false,
					owner: raffleProgram.programId,
					lamports: 1 * LAMPORTS_PER_SOL,
					data: entryData,
				});

				totalTickets += entry.ticketCount;
				if (entry.isWinningEntry) {
					winningSeed = entrySeed;
				}
			}

			// Manually set the winning ticket
			const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
				metadataUri,
				ticketPrice,
				minTickets,
				endTime: new BN(creationTime.toString()),
				treasury: treasuryId,
				currentTickets: new BN(totalTickets),
				creationTime: new BN(creationTime.toString()),
				raffleState: {
					drawing: {},
				},
				winnerAddress: new Keypair().publicKey, // We need to assign some random public key here, to assign the space
				winningTicket: new BN(input.winningTicket),
				maxTickets: null,
			});
			provider.client.setAccount(raffleAccountId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: raffleData,
			});

			const raffleBeforeDraw =
				await raffleProgram.account.raffle.fetch(raffleAccountId);

			// Set winner
			await raffleProgram.methods
				.setWinner(Array.from(winningSeed))
				.accounts({
					raffle: raffleAccountId,
				})
				.rpc();

			// Fetch the raffle account and validate the state
			const raffle = await raffleProgram.account.raffle.fetch(raffleAccountId);
			expect(
				raffle.winnerAddress?.equals(
					input.entries.find((e) => e.isWinningEntry)?.keypair.publicKey ??
						new Keypair().publicKey,
				),
			).toBeTrue();
			expect(raffle.raffleState.drawn).toBeDefined();
			expect(raffle.raffleState.open).toBeUndefined();
			expect(raffle.raffleState.expired).toBeUndefined();
			expect(raffle.raffleState.drawing).toBeUndefined();
			expect(raffle.raffleState.claimed).toBeUndefined();

			// Verify no other fields have changed
			expect(raffleBeforeDraw.creationTime.eq(raffle.creationTime)).toBeTrue();
			expect(
				raffleBeforeDraw.currentTickets.eq(raffle.currentTickets),
			).toBeTrue();
			expect(raffleBeforeDraw.endTime.eq(raffle.endTime)).toBeTrue();
			expect(raffleBeforeDraw.metadataUri).toEqual(raffle.metadataUri);
			expect(raffleBeforeDraw.minTickets.eq(raffle.minTickets)).toBeTrue();
			expect(raffleBeforeDraw.ticketPrice.eq(raffle.ticketPrice)).toBeTrue();
			expect(raffleBeforeDraw.treasury.equals(raffle.treasury)).toBeTrue();
			expect(
				raffleBeforeDraw.winningTicket?.eq(raffle.winningTicket ?? new BN(-1)),
			).toBeTrue;
		}
	});

	it("should fail when the raffle is not in drawing state", async () => {
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

		const notDrawingStates = ["open", "expired", "drawn", "claimed"];
		for (const state of notDrawingStates) {
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

			// Calculate rent needed for ticket balance and entry account
			const rentBase = provider.client.getRent();
			const rentNeeded = rentBase.minimumBalance(
				BigInt(
					raffleProgram.account.entry.size +
						raffleProgram.account.ticketBalance.size,
				),
			);

			const account = new Keypair();

			// Mint rent needed + 0.1 SOL for fees
			provider.client.airdrop(
				account.publicKey,
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
					signer: account.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([account])
				.rpc();

			const randomBytes = new Uint8Array(8);
			crypto.getRandomValues(randomBytes);
			const entrySeed = randomBytes;

			// Manually create entry PDA
			const entryAccountId = PublicKey.findProgramAddressSync(
				[Buffer.from("entry"), raffleAccountId.toBytes(), entrySeed],
				raffleProgram.programId,
			)[0];

			const entryData = await raffleProgram.coder.accounts.encode("entry", {
				raffle: raffleAccountId,
				owner: account.publicKey,
				ticketCount: new BN(1),
				ticketStartIndex: new BN(0),
				seed: Array.from(entrySeed),
			});
			provider.client.setAccount(entryAccountId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: entryData,
			});

			// Manually set the winning ticket
			const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
				metadataUri,
				ticketPrice,
				minTickets,
				endTime: new BN(creationTime.toString()),
				treasury: treasuryId,
				currentTickets: new BN(1),
				creationTime: new BN(creationTime.toString()),
				raffleState: {
					[state]: {},
				},
				winnerAddress: new Keypair().publicKey, // We need to assign some random public key here, to assign the space
				winningTicket: new BN(0),
				maxTickets: null,
			});
			provider.client.setAccount(raffleAccountId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: raffleData,
			});

			// Set winner
			expect(
				raffleProgram.methods
					.setWinner(Array.from(entrySeed))
					.accounts({
						raffle: raffleAccountId,
					})
					.rpc(),
			).rejects.toThrow(/RaffleNotDrawing/);
		}
	});

	it("should fail when the submitted entry does not contain the winning ticket", async () => {
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
			winningTicket: number;
			ticketStartIndex: number;
			ticketCount: number;
			totalTickets: number;
		}[] = [
			{
				winningTicket: 0,
				ticketStartIndex: 1,
				ticketCount: 1,
				totalTickets: 1,
			},
			{
				winningTicket: 1,
				ticketStartIndex: 0,
				ticketCount: 1,
				totalTickets: 2,
			},
			{
				winningTicket: 10,
				ticketStartIndex: 0,
				ticketCount: 5,
				totalTickets: 11,
			},
			{
				winningTicket: 20,
				ticketStartIndex: 21,
				ticketCount: 5,
				totalTickets: 26,
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

			// Calculate rent needed for ticket balance and entry account
			const rentBase = provider.client.getRent();
			const rentNeeded = rentBase.minimumBalance(
				BigInt(
					raffleProgram.account.entry.size +
						raffleProgram.account.ticketBalance.size,
				),
			);

			const account = new Keypair();

			// Mint rent needed + 0.1 SOL for fees
			provider.client.airdrop(
				account.publicKey,
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
					signer: account.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([account])
				.rpc();

			const randomBytes = new Uint8Array(8);
			crypto.getRandomValues(randomBytes);
			const entrySeed = randomBytes;

			// Manually create entry PDA
			const entryAccountId = PublicKey.findProgramAddressSync(
				[Buffer.from("entry"), raffleAccountId.toBytes(), entrySeed],
				raffleProgram.programId,
			)[0];

			const entryData = await raffleProgram.coder.accounts.encode("entry", {
				raffle: raffleAccountId,
				owner: account.publicKey,
				ticketCount: new BN(input.ticketCount),
				ticketStartIndex: new BN(input.ticketStartIndex),
				seed: Array.from(entrySeed),
			});
			provider.client.setAccount(entryAccountId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: entryData,
			});

			// Manually set the winning ticket
			const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
				metadataUri,
				ticketPrice,
				minTickets,
				endTime: new BN(creationTime.toString()),
				treasury: treasuryId,
				currentTickets: new BN(input.totalTickets),
				creationTime: new BN(creationTime.toString()),
				raffleState: {
					drawing: {},
				},
				winnerAddress: new Keypair().publicKey, // We need to assign some random public key here, to assign the space
				winningTicket: new BN(input.winningTicket),
				maxTickets: null,
			});
			provider.client.setAccount(raffleAccountId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: raffleData,
			});

			// Set winner
			expect(
				raffleProgram.methods
					.setWinner(Array.from(entrySeed))
					.accounts({
						raffle: raffleAccountId,
					})
					.rpc(),
			).rejects.toThrow(/InvalidWinningEntry/);
		}
	});
});
