import { describe, expect, it } from "bun:test";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { LiteSVMProvider, fromWorkspace } from "anchor-litesvm";
import type { RaffleProgram } from "../target/types/raffle_program";
const IDL = require("../target/idl/raffle_program.json");

describe("expire_raffle", async () => {
	it("should successfully expire an open raffle that has ended and not met the ticket threshold", async () => {
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
			minTickets: number;
			ticketsBought: number;
		}[] = [
			{ minTickets: 1, ticketsBought: 0 },
			{ minTickets: 10, ticketsBought: 0 },
			{ minTickets: 10, ticketsBought: 9 },
			{ minTickets: 50, ticketsBought: 5 },
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

			if (input.ticketsBought > 0) {
				const buyer = new Keypair();
				provider.client.airdrop(
					buyer.publicKey,
					BigInt(ticketPrice.mul(new BN(input.ticketsBought)).toString()) +
						BigInt(1 * LAMPORTS_PER_SOL),
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

				// Purchase tickets
				await raffleProgram.methods
					.buyTickets(new BN(input.ticketsBought), Array.from(entrySeed))
					.accounts({
						signer: buyer.publicKey,
						raffle: new PublicKey(raffleAccountId),
					})
					.signers([buyer])
					.rpc();
			}

			const raffleAccountBefore =
				await raffleProgram.account.raffle.fetch(raffleAccountId);

			// Time-travel to when the raffle ends
			const newClock = client.getClock();
			newClock.unixTimestamp = creationTime + BigInt(3602);
			client.setClock(newClock);

			// Expire raffle
			await raffleProgram.methods
				.expireRaffle()
				.accounts({ raffle: raffleAccountId })
				.rpc();

			// Fetch raffle account and check that state is expired
			const raffleAccount =
				await raffleProgram.account.raffle.fetch(raffleAccountId);
			expect(raffleAccount.raffleState.expired).toBeDefined();
			expect(raffleAccount.raffleState.claimed).toBeUndefined();
			expect(raffleAccount.raffleState.drawing).toBeUndefined();
			expect(raffleAccount.raffleState.drawn).toBeUndefined();
			expect(raffleAccount.raffleState.open).toBeUndefined();

			// Verify nothing else has changed
			expect(
				raffleAccountBefore.creationTime.eq(raffleAccount.creationTime),
			).toBeTrue();
			expect(
				raffleAccountBefore.currentTickets.eq(raffleAccount.currentTickets),
			).toBeTrue();
			expect(raffleAccountBefore.endTime.eq(raffleAccount.endTime)).toBeTrue();
			expect(raffleAccountBefore.metadataUri).toEqual(
				raffleAccount.metadataUri,
			);
			expect(
				raffleAccountBefore.minTickets.eq(raffleAccount.minTickets),
			).toBeTrue();
			expect(
				raffleAccountBefore.ticketPrice.eq(raffleAccount.ticketPrice),
			).toBeTrue();
			expect(
				raffleAccountBefore.treasury.equals(raffleAccount.treasury),
			).toBeTrue();
			expect(raffleAccount.winningTicket).toBeNull();
			expect(raffleAccount.winnerAddress).toBeNull();
		}
	});

	it("should fail for a raffle that is not in open state", async () => {
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

			expect(
				raffleProgram.methods
					.expireRaffle()
					.accounts({
						raffle: raffleAccountId,
					})
					.rpc(),
			).rejects.toThrow(/RaffleNotOpen/);
		}
	});

	it("should fail for a raffle that has not ended yet", async () => {
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

		// Expire raffle
		expect(
			raffleProgram.methods
				.expireRaffle()
				.accounts({ raffle: raffleAccountId })
				.rpc(),
		).rejects.toThrow(/RaffleNotEnded/);
	});

	it("should fail for a raffle that has met the ticket threshold", async () => {
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
		provider.client.airdrop(
			buyer.publicKey,
			BigInt(ticketPrice.mul(minTickets).toString()) +
				BigInt(1 * LAMPORTS_PER_SOL),
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

		// Purchase tickets
		await raffleProgram.methods
			.buyTickets(minTickets, Array.from(entrySeed))
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

		expect(
			raffleProgram.methods
				.expireRaffle()
				.accounts({ raffle: raffleAccountId })
				.rpc(),
		).rejects.toThrow(/ThresholdIsMet/);
	});
});
