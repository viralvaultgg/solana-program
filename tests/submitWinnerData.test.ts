import { describe, expect, it } from "bun:test";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { LiteSVMProvider, fromWorkspace } from "anchor-litesvm";
import type { RaffleProgram } from "../target/types/raffle_program";
const IDL = require("../target/idl/raffle_program.json");

describe("submit_winner_data", async () => {
	it("should successfully let the winner submit data for a drawn raffle", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const winnerId = new Keypair();

		provider.client.airdrop(winnerId.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
			})
			.rpc();

		const inputs = ["short", new Array(854).fill("x").join("")];

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

			// Manually set the raffle state to drawn
			const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
				metadataUri,
				ticketPrice,
				minTickets,
				currentTickets: minTickets,
				endTime: new BN(creationTime.toString()),
				treasury: treasuryId,
				creationTime: new BN(creationTime.toString()),
				raffleState: {
					drawn: {},
				},
				winnerAddress: winnerId.publicKey,
				winningTicket: null,
				maxTickets: null,
			});
			provider.client.setAccount(raffleAccountId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: raffleData,
			});

			// The data on the contract should be set RAW, just like the client sends it
			const winnerData = input;
			await raffleProgram.methods
				.submitWinnerData(winnerData)
				.accounts({ raffle: raffleAccountId, signer: winnerId.publicKey })
				.signers([winnerId])
				.rpc();

			// Fetch the winner data account and validate that the data matches
			const winnerDataId = PublicKey.findProgramAddressSync(
				[
					Buffer.from("winner_data"),
					raffleAccountId.toBytes(),
					winnerId.publicKey.toBytes(),
				],
				raffleProgram.programId,
			)[0];
			const winnerDataAccount =
				await raffleProgram.account.winnerData.fetch(winnerDataId);
			expect(winnerDataAccount.data).toEqual(winnerData);

			// Fetch raffle account and check if state has been updated properly
			const raffleAccount =
				await raffleProgram.account.raffle.fetch(raffleAccountId);
			expect(raffleAccount.raffleState.claimed).toBeDefined();
			expect(raffleAccount.raffleState.open).toBeUndefined();
			expect(raffleAccount.raffleState.expired).toBeUndefined();
			expect(raffleAccount.raffleState.drawing).toBeUndefined();
			expect(raffleAccount.raffleState.drawn).toBeUndefined();
		}
	});

	it("should fail for raffles that are now in a drawn state", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const winnerId = new Keypair();

		provider.client.airdrop(winnerId.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
			})
			.rpc();

		const notDrawnStates = ["open", "expired", "drawing", "claimed"];

		for (const state of notDrawnStates) {
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
			const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
				metadataUri,
				ticketPrice,
				minTickets,
				currentTickets: minTickets,
				endTime: new BN(creationTime.toString()),
				treasury: treasuryId,
				creationTime: new BN(creationTime.toString()),
				raffleState: {
					[state]: {},
				},
				winnerAddress: winnerId.publicKey,
				winningTicket: null,
				maxTickets: null,
			});
			provider.client.setAccount(raffleAccountId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: raffleData,
			});

			// The data on the contract should be set RAW, just like the client sends it
			const winnerData = "data";
			expect(
				raffleProgram.methods
					.submitWinnerData(winnerData)
					.accounts({ raffle: raffleAccountId, signer: winnerId.publicKey })
					.signers([winnerId])
					.rpc(),
			).rejects.toThrow(/RaffleNotDrawn/);
		}
	});

	it("should fail when an account other than the winner tries to submit data", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const winnerId = new Keypair();

		provider.client.airdrop(winnerId.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
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

		// Manually set the raffle state to drawn
		const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
			metadataUri,
			ticketPrice,
			minTickets,
			currentTickets: minTickets,
			endTime: new BN(creationTime.toString()),
			treasury: treasuryId,
			creationTime: new BN(creationTime.toString()),
			raffleState: {
				drawn: {},
			},
			winnerAddress: winnerId.publicKey,
			winningTicket: null,
			maxTickets: null,
		});
		provider.client.setAccount(raffleAccountId, {
			executable: false,
			owner: raffleProgram.programId,
			lamports: 1 * LAMPORTS_PER_SOL,
			data: raffleData,
		});

		// Send the transaction as another account
		const notTheWinner = new Keypair();
		provider.client.airdrop(
			notTheWinner.publicKey,
			BigInt(1 * LAMPORTS_PER_SOL),
		);

		const winnerData = "data";
		expect(
			raffleProgram.methods
				.submitWinnerData(winnerData)
				.accounts({ raffle: raffleAccountId, signer: notTheWinner.publicKey })
				.signers([notTheWinner])
				.rpc(),
		).rejects.toThrow(/NotWinner/);
	});

	it("should fail when the data invalid", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const winnerId = new Keypair();

		provider.client.airdrop(winnerId.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

		// Init config
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: provider.publicKey,
				payoutAuthority: provider.publicKey,
			})
			.rpc();

		const inputs: { data: string; errorRegex: RegExp }[] = [
			{ data: "", errorRegex: /InvalidDataLength./ },
			{
				data: new Array(855).fill("a").join(""),
				errorRegex: /Transaction too large/,
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

			// Manually set the raffle state to drawn
			const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
				metadataUri,
				ticketPrice,
				minTickets,
				currentTickets: minTickets,
				endTime: new BN(creationTime.toString()),
				treasury: treasuryId,
				creationTime: new BN(creationTime.toString()),
				raffleState: {
					drawn: {},
				},
				winnerAddress: winnerId.publicKey,
				winningTicket: null,
				maxTickets: null,
			});
			provider.client.setAccount(raffleAccountId, {
				executable: false,
				owner: raffleProgram.programId,
				lamports: 1 * LAMPORTS_PER_SOL,
				data: raffleData,
			});

			// Send the transaction with invalid data
			const winnerData = input.data;
			expect(
				raffleProgram.methods
					.submitWinnerData(winnerData)
					.accounts({ raffle: raffleAccountId, signer: winnerId.publicKey })
					.signers([winnerId])
					.rpc(),
			).rejects.toThrow(input.errorRegex);
		}
	});
});
