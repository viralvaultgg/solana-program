import { describe, expect, it } from "bun:test";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { LiteSVMProvider, fromWorkspace } from "anchor-litesvm";
import type { RaffleProgram } from "../target/types/raffle_program";
const IDL = require("../target/idl/raffle_program.json");

describe("init_config", async () => {
	it("should successfully initialize the config account with the correct data", async () => {
		// We test with arbitrary Keypairs, as well as the case where the signer is used as managementAuthority and/or payoutAuthority
		const inputs: {
			managementAuthority: Keypair | "signer";
			payoutAuthority: Keypair | "signer";
		}[] = [
			{
				managementAuthority: new Keypair(),
				payoutAuthority: new Keypair(),
			},
			{
				managementAuthority: "signer",
				payoutAuthority: "signer",
			},
			{
				managementAuthority: new Keypair(),
				payoutAuthority: "signer",
			},
			{
				managementAuthority: "signer",
				payoutAuthority: new Keypair(),
			},
		];

		for (const input of inputs) {
			const client = fromWorkspace(".");
			const provider = new LiteSVMProvider(client);
			const raffleProgram = new Program<RaffleProgram>(IDL, provider);

			const managementAuthority =
				input.managementAuthority === "signer"
					? provider.publicKey
					: input.managementAuthority.publicKey;
			const payoutAuthority =
				input.payoutAuthority === "signer"
					? provider.publicKey
					: input.payoutAuthority.publicKey;

			await raffleProgram.methods
				.initConfig()
				.accounts({
					managementAuthority: managementAuthority,
					payoutAuthority: payoutAuthority,
				})
				.rpc();

			// Validating the data from the config account also implicitly validates that
			// the PDA is derived from the correct seeds, since otherwise the fetch would fail
			const [configId, bump] = PublicKey.findProgramAddressSync(
				[Buffer.from("config")],
				raffleProgram.programId,
			);
			const configAccount = await raffleProgram.account.config.fetch(configId);

			expect(configAccount.managementAuthority).toEqual(managementAuthority);
			expect(configAccount.upgradeAuthority).toEqual(provider.publicKey);
			expect(configAccount.payoutAuthority).toEqual(payoutAuthority);
			expect(configAccount.bump).toEqual(bump);
			expect(configAccount.raffleCounter.eq(new BN(0))).toBeTrue();
		}
	});

	it("should not allow duplicate initialization", async () => {
		// We test with arbitrary Keypairs, as well as the case where the signer is used as managementAuthority and/or payoutAuthority
		const inputs: {
			managementAuthority: Keypair | "signer";
			payoutAuthority: Keypair | "signer";
		}[] = [
			{
				managementAuthority: new Keypair(),
				payoutAuthority: new Keypair(),
			},
			{
				managementAuthority: "signer",
				payoutAuthority: "signer",
			},
			{
				managementAuthority: new Keypair(),
				payoutAuthority: "signer",
			},
			{
				managementAuthority: "signer",
				payoutAuthority: new Keypair(),
			},
		];

		for (const input of inputs) {
			const client = fromWorkspace(".");
			const provider = new LiteSVMProvider(client);
			const raffleProgram = new Program<RaffleProgram>(IDL, provider);

			const managementAuthority =
				input.managementAuthority === "signer"
					? provider.publicKey
					: input.managementAuthority.publicKey;
			const payoutAuthority =
				input.payoutAuthority === "signer"
					? provider.publicKey
					: input.payoutAuthority.publicKey;

			// First call should succeed
			await raffleProgram.methods
				.initConfig()
				.accounts({
					managementAuthority: managementAuthority,
					payoutAuthority: payoutAuthority,
				})
				.rpc();

			// Second call should fail
			expect(
				raffleProgram.methods
					.initConfig()
					.accounts({
						managementAuthority: managementAuthority,
						payoutAuthority: payoutAuthority,
					})
					.rpc(),
			).rejects.toThrow();
		}
	});
});
