import { describe, expect, it } from "bun:test";
import { BN, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { LiteSVMProvider, fromWorkspace } from "anchor-litesvm";
import type { RaffleProgram } from "../target/types/raffle_program";
const IDL = require("../target/idl/raffle_program.json");

describe("init_ticket_balance", async () => {
	it("should successfully initialize a ticket balance for multiple users on an open raffle", async () => {
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

		const numAccounts = 10;
		for (let i = 0; i < numAccounts; i++) {
			const wallet = new Keypair();
			provider.client.airdrop(wallet.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

			await raffleProgram.methods
				.initTicketBalance()
				.accounts({
					signer: wallet.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([wallet])
				.rpc();

			// Fetch the ticket balance account
			const [ticketBalanceId, bump] = PublicKey.findProgramAddressSync(
				[
					Buffer.from("ticket_balance"),
					raffleAccountId.toBytes(),
					wallet.publicKey.toBytes(),
				],
				raffleProgram.programId,
			);
			const ticketBalanceAccount =
				await raffleProgram.account.ticketBalance.fetch(ticketBalanceId);

			// Validate data
			expect(ticketBalanceAccount.bump).toEqual(bump);
			expect(ticketBalanceAccount.owner.equals(wallet.publicKey)).toBeTrue();
			expect(ticketBalanceAccount.ticketCount.eq(new BN(0))).toBeTrue();
		}
	});

	it("should successfully initialize a ticket balance for a user on multiple open raffles", async () => {
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

		const numRaffles = 5;
		for (let i = 0; i < numRaffles; i++) {
			const wallet = new Keypair();
			provider.client.airdrop(wallet.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

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

			await raffleProgram.methods
				.initTicketBalance()
				.accounts({
					signer: wallet.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([wallet])
				.rpc();

			// Fetch the ticket balance account
			const [ticketBalanceId, bump] = PublicKey.findProgramAddressSync(
				[
					Buffer.from("ticket_balance"),
					raffleAccountId.toBytes(),
					wallet.publicKey.toBytes(),
				],
				raffleProgram.programId,
			);
			const ticketBalanceAccount =
				await raffleProgram.account.ticketBalance.fetch(ticketBalanceId);

			// Validate data
			expect(ticketBalanceAccount.bump).toEqual(bump);
			expect(ticketBalanceAccount.owner.equals(wallet.publicKey)).toBeTrue();
			expect(ticketBalanceAccount.ticketCount.eq(new BN(0))).toBeTrue();
		}
	});

	it("should fail on raffles that are not in the open state", async () => {
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

			const buyer = new Keypair();
			provider.client.airdrop(buyer.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

			// Manually set the raffle data
			const raffleData = await raffleProgram.coder.accounts.encode("raffle", {
				metadataUri,
				ticketPrice,
				minTickets,
				endTime: new BN(creationTime.toString()),
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

			// Init ticket balance, should fail
			expect(
				raffleProgram.methods
					.initTicketBalance()
					.accounts({
						signer: buyer.publicKey,
						raffle: raffleAccountId,
					})
					.signers([buyer])
					.rpc(),
			).rejects.toThrow(/RaffleNotOpen/);
		}
	});

	it("should fail when trying to initiate a ticket balance for a user that already has one on a given raffle", async () => {
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

		const wallet = new Keypair();
		provider.client.airdrop(wallet.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

		// First initialization should work
		await raffleProgram.methods
			.initTicketBalance()
			.accounts({
				signer: wallet.publicKey,
				raffle: new PublicKey(raffleAccountId),
			})
			.signers([wallet])
			.rpc();

		expect(
			raffleProgram.methods
				.initTicketBalance()
				.accounts({
					signer: wallet.publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([wallet])
				.rpc(),
		).rejects.toThrow();
	});

	it("should fail when an account tries to create a ticket balance for another account", async () => {
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

		const wallet = new Keypair();
		provider.client.airdrop(wallet.publicKey, BigInt(1 * LAMPORTS_PER_SOL));

		expect(
			raffleProgram.methods
				.initTicketBalance()
				.accountsPartial({
					signer: new Keypair().publicKey,
					raffle: new PublicKey(raffleAccountId),
				})
				.signers([wallet])
				.rpc(),
		).rejects.toThrow(/unknown signer/);
	});
});
