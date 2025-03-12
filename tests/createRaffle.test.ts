import { describe, expect, it } from "bun:test";
import { BN, Program, utils } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { LiteSVMProvider, fromWorkspace } from "anchor-litesvm";
import type { RaffleProgram } from "../target/types/raffle_program";
const IDL = require("../target/idl/raffle_program.json");

describe("create_raffle", async () => {
	it("should successfully create a raffle and set the correct state", async () => {
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

		const inputs: {
			metadataUri: string;
			ticketPrice: BN;
			minTickets: BN;
			expiresIn: bigint;
			maxTickets?: BN;
		}[] = [
			{
				metadataUri: "https://www.example.org",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(3601),
			},
			{
				metadataUri: "ipfs://someUri",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(3601),
			},
			{
				metadataUri: "ipfs://ipfs/someUri",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(3601),
			},
			{
				metadataUri: "https://www.example.org",
				ticketPrice: new BN(100 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(3601),
			},
			{
				metadataUri: "https://www.example.org",
				ticketPrice: new BN(100 * LAMPORTS_PER_SOL),
				minTickets: new BN(1_000_000),
				expiresIn: BigInt(3601),
			},
			{
				metadataUri: "https://www.example.org",
				ticketPrice: new BN(100 * LAMPORTS_PER_SOL),
				minTickets: new BN(1_000_000),
				expiresIn: BigInt(2592000),
			},
			{
				metadataUri: `https://${new Array(248).fill("a").join("")}`,
				ticketPrice: new BN(100 * LAMPORTS_PER_SOL),
				minTickets: new BN(1_000_000),
				expiresIn: BigInt(2592000),
			},
			{
				metadataUri: `https://${new Array(248).fill("a").join("")}`,
				ticketPrice: new BN(100 * LAMPORTS_PER_SOL),
				minTickets: new BN(1_000),
				maxTickets: new BN(10_000),
				expiresIn: BigInt(2592000),
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

			const metadataUri = input.metadataUri;
			const ticketPrice = input.ticketPrice;
			const minTickets = input.minTickets;
			const endTime = new BN((creationTime + input.expiresIn).toString());
			const maxTickets = input.maxTickets ?? null;

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
			const [treasuryId, treasuryBump] = PublicKey.findProgramAddressSync(
				[Buffer.from("treasury"), raffleAccountId.toBuffer()],
				raffleProgram.programId,
			);

			// Validate account is initialized correctly
			const raffleAccount =
				await raffleProgram.account.raffle.fetch(raffleAccountId);

			// From input
			expect(raffleAccount.metadataUri).toEqual(metadataUri);
			expect(raffleAccount.ticketPrice.eq(ticketPrice)).toBeTrue();
			expect(raffleAccount.minTickets.eq(minTickets)).toBeTrue();
			expect(raffleAccount.endTime.eq(endTime)).toBeTrue();

			// Defaults
			expect(raffleAccount.treasury.equals(treasuryId)).toBeTrue();
			expect(raffleAccount.currentTickets.eq(new BN(0))).toBeTrue();
			expect(
				raffleAccount.creationTime.eq(new BN(creationTime.toString())),
			).toBeTrue();
			expect(raffleAccount.raffleState.open).toBeDefined();
			expect(raffleAccount.raffleState.claimed).toBeUndefined();
			expect(raffleAccount.raffleState.drawing).toBeUndefined();
			expect(raffleAccount.raffleState.drawn).toBeUndefined();
			expect(raffleAccount.raffleState.expired).toBeUndefined();
			expect(raffleAccount.winnerAddress).toBeNull();
			expect(raffleAccount.winningTicket).toBeNull();

			// Validate treasury account is initialized correctly
			const treasuryAccount =
				await raffleProgram.account.treasury.fetch(treasuryId);
			expect(treasuryAccount.bump).toEqual(treasuryBump);
			expect(treasuryAccount.raffle.equals(raffleAccountId)).toBeTrue();

			// Validate that the raffle counter has been increased by one
			const configAccount = await raffleProgram.account.config.fetch(configId);
			expect(
				configAccount.raffleCounter.eq(initialRaffleCounter.add(new BN(1))),
			).toBeTrue();
		}
	});

	it("should fail with invalid metadata uris", async () => {
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

		const inputs: {
			metadataUri: string;
			ticketPrice: BN;
			minTickets: BN;
			expiresIn: bigint;
			errorRegex: RegExp;
		}[] = [
			{
				metadataUri: `https://${new Array(249).fill("a").join("")}`,
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(3601),
				errorRegex: /MetadataUriTooLong/,
			},
			{
				metadataUri: "invalidPrefix",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(3601),
				errorRegex: /InvalidMetadataUri/,
			},
			{
				metadataUri: "",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(3601),
				errorRegex: /InvalidMetadataUri/,
			},
		];

		for (const input of inputs) {
			const creationTime = client.getClock().unixTimestamp;
			const metadataUri = input.metadataUri;
			const ticketPrice = input.ticketPrice;
			const minTickets = input.minTickets;
			const endTime = new BN((creationTime + input.expiresIn).toString());

			expect(
				raffleProgram.methods
					.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
					.rpc(),
			).rejects.toThrow(input.errorRegex);
		}
	});

	it("should fail with invalid ticket prices", async () => {
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

		const inputs: {
			metadataUri: string;
			ticketPrice: BN;
			minTickets: BN;
			expiresIn: bigint;
			errorRegex: RegExp;
		}[] = [
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(0),
				minTickets: new BN(1),
				expiresIn: BigInt(3601),
				errorRegex: /TicketPriceTooLow/,
			},
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(0.09 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(3601),
				errorRegex: /TicketPriceTooLow/,
			},
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(100.01 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(3601),
				errorRegex: /TicketPriceTooHigh/,
			},
		];

		for (const input of inputs) {
			const creationTime = client.getClock().unixTimestamp;
			const metadataUri = input.metadataUri;
			const ticketPrice = input.ticketPrice;
			const minTickets = input.minTickets;
			const endTime = new BN((creationTime + input.expiresIn).toString());

			expect(
				raffleProgram.methods
					.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
					.rpc(),
			).rejects.toThrow(input.errorRegex);
		}
	});

	it("should fail with invalid minimum ticket amounts", async () => {
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

		const inputs: {
			metadataUri: string;
			ticketPrice: BN;
			minTickets: BN;
			expiresIn: bigint;
			errorRegex: RegExp;
		}[] = [
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(0),
				expiresIn: BigInt(3601),
				errorRegex: /MinTicketsTooLow/,
			},
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1_000_001),
				expiresIn: BigInt(3601),
				errorRegex: /MinTicketsTooHigh/,
			},
		];

		for (const input of inputs) {
			const creationTime = client.getClock().unixTimestamp;
			const metadataUri = input.metadataUri;
			const ticketPrice = input.ticketPrice;
			const minTickets = input.minTickets;
			const endTime = new BN((creationTime + input.expiresIn).toString());

			expect(
				raffleProgram.methods
					.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
					.rpc(),
			).rejects.toThrow(input.errorRegex);
		}
	});

	it("should fail with invalid maximum ticket amounts", async () => {
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

		const inputs: {
			metadataUri: string;
			ticketPrice: BN;
			minTickets: BN;
			maxTickets: BN;
			expiresIn: bigint;
			errorRegex: RegExp;
		}[] = [
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				maxTickets: new BN(0),
				expiresIn: BigInt(3601),
				errorRegex: /MaxTicketsTooLow/,
			},
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1000),
				maxTickets: new BN(10),
				expiresIn: BigInt(3601),
				errorRegex: /MaxTicketsTooLow/,
			},
		];

		for (const input of inputs) {
			const creationTime = client.getClock().unixTimestamp;
			const metadataUri = input.metadataUri;
			const ticketPrice = input.ticketPrice;
			const minTickets = input.minTickets;
			const endTime = new BN((creationTime + input.expiresIn).toString());
			const maxTickets = input.maxTickets;

			expect(
				raffleProgram.methods
					.createRaffle(
						metadataUri,
						ticketPrice,
						endTime,
						minTickets,
						maxTickets,
					)
					.rpc(),
			).rejects.toThrow(input.errorRegex);
		}
	});

	it("should fail with invalid end times", async () => {
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

		const inputs: {
			metadataUri: string;
			ticketPrice: BN;
			minTickets: BN;
			expiresIn: bigint;
			errorRegex: RegExp;
		}[] = [
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(-3600),
				errorRegex: /EndTimeTooClose/,
			},
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(3600),
				errorRegex: /EndTimeTooClose/,
			},
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(60),
				errorRegex: /EndTimeTooClose/,
			},
			{
				metadataUri: "https://www.example.com",
				ticketPrice: new BN(0.1 * LAMPORTS_PER_SOL),
				minTickets: new BN(1),
				expiresIn: BigInt(2592001),
				errorRegex: /DurationTooLong/,
			},
		];

		for (const input of inputs) {
			const creationTime = client.getClock().unixTimestamp;
			const metadataUri = input.metadataUri;
			const ticketPrice = input.ticketPrice;
			const minTickets = input.minTickets;
			const endTime = new BN((creationTime + input.expiresIn).toString());

			expect(
				raffleProgram.methods
					.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
					.rpc(),
			).rejects.toThrow(input.errorRegex);
		}
	});

	it("should not be possible to create new raffles from accounts other than the management authority", async () => {
		const client = fromWorkspace(".");
		const provider = new LiteSVMProvider(client);
		const raffleProgram = new Program<RaffleProgram>(IDL, provider);
		const managementAuthority = new Keypair();

		// Init config with custom management authority
		await raffleProgram.methods
			.initConfig()
			.accounts({
				managementAuthority: managementAuthority.publicKey,
				payoutAuthority: provider.publicKey,
			})
			.rpc();

		const creationTime = client.getClock().unixTimestamp;
		const metadataUri = "https://ww.example.org";
		const ticketPrice = new BN(1 * LAMPORTS_PER_SOL);
		const minTickets = new BN(1);
		const endTime = new BN((creationTime + BigInt(3601)).toString());

		// Create raffle from the provider keypair, which is NOT the management authority in this case
		expect(
			raffleProgram.methods
				.createRaffle(metadataUri, ticketPrice, endTime, minTickets, null)
				.rpc(),
		).rejects.toThrow(/NotProgramManagementAuthority/);
	});
});
