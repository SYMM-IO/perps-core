import { createMPT, createMerkleProof } from "@ethereumjs/mpt"
import { expect } from "chai"

import { buildStorageImport, buildStorageSnapshot } from "../../deployment-tooling/operations/storage-snapshot.js"
import { ethers } from "../helpers/hardhat-connection.js"

describe("Complete storage migration", function () {
	async function fixture(entries?: { slot: string; value: string }[]) {
		const [deployer, importer, upgrader, user] = await ethers.getSigners()
		const Target = await ethers.getContractFactory("StorageMigrationTarget")
		const target = await Target.deploy()
		const values = entries ?? [
			{ slot: ethers.toBeHex(0, 32), value: ethers.toBeHex(123, 32) },
			{ slot: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [user.address, 1])), value: ethers.toBeHex(66, 32) },
		]
		const storage = await createMPT({ useKeyHashing: true })
		for (const entry of values) await storage.put(ethers.getBytes(entry.slot), ethers.getBytes(ethers.encodeRlp(ethers.toBeHex(BigInt(entry.value)))))
		const storageRoot = ethers.hexlify(storage.root()),
			codeHash = ethers.keccak256(await ethers.provider.getCode(target.target))
		const accountTrie = await createMPT({ useKeyHashing: true })
		await accountTrie.put(ethers.getBytes(target.target), ethers.getBytes(ethers.encodeRlp(["0x01", "0x", storageRoot, codeHash])))
		const block = await ethers.provider.getBlock("latest")
		const source = {
			chainId: Number((await ethers.provider.getNetwork()).chainId),
			address: String(target.target),
			blockNumber: block!.number,
			blockHash: block!.hash!,
			stateRoot: ethers.hexlify(accountTrie.root()),
			codeHash,
			storageRoot,
		}
		const proof = (await createMerkleProof(accountTrie, ethers.getBytes(target.target))).map(ethers.hexlify)
		const plan = await buildStorageImport(await buildStorageSnapshot(source, values, proof))
		const commitment = plan.snapshotDigest.replace("sha256:", "0x")
		const Migration = await ethers.getContractFactory("StorageMigration")
		const implementation = await Migration.deploy(importer.address, commitment, plan.root, plan.count)
		const Coordinator = await ethers.getContractFactory("StorageMigrationCoordinator")
		const coordinator = await Coordinator.deploy(upgrader.address, implementation.target, target.target)
		const proxyAddress = await coordinator.proxy()
		const migration = await ethers.getContractAt("StorageMigration", proxyAddress)
		const adminWord = await ethers.provider.getStorage(proxyAddress, ethers.toBeHex(BigInt(ethers.id("eip1967.proxy.admin")) - 1n, 32))
		const admin = new ethers.Contract(
			ethers.getAddress(ethers.dataSlice(adminWord, 12)),
			["function owner() view returns (address)", "function upgradeAndCall(address proxy,address implementation,bytes data) payable"],
			upgrader,
		)
		return { deployer, importer, upgrader, user, target, implementation, coordinator, migration, admin, plan, proxyAddress }
	}

	it("resumes chunks, preserves unknown mapping state, then hands off upgrade ownership", async function () {
		const f = await fixture()
		await expect(f.migration.connect(f.deployer).importStorage(0, [f.plan.items[0]])).to.be.revertedWithCustomError(
			f.migration,
			"UnauthorizedMigration",
		)
		await expect(f.implementation.connect(f.importer).importStorage(0, [f.plan.items[0]])).to.be.revertedWithCustomError(
			f.migration,
			"UnauthorizedMigration",
		)
		await expect(f.coordinator.connect(f.upgrader).activate(f.admin.target, "0x")).to.be.revertedWithCustomError(f.coordinator, "MigrationNotSealed")
		await f.migration.connect(f.importer).importStorage(0, [f.plan.items[0]])
		expect((await f.migration.migrationProgress())[0]).to.equal(1)
		await expect(f.migration.connect(f.importer).importStorage(0, [f.plan.items[0]])).to.be.revertedWithCustomError(f.migration, "InvalidMigration")
		await expect(f.migration.connect(f.importer).sealMigration()).to.be.revertedWithCustomError(f.migration, "IncompleteMigration")
		await f.migration.connect(f.importer).importStorage(1, [f.plan.items[1]])
		await f.migration.connect(f.importer).sealMigration()
		await expect(f.migration.connect(f.importer).importStorage(2, [])).to.be.revertedWithCustomError(f.migration, "InvalidMigration")
		await expect(f.coordinator.connect(f.importer).activate(f.admin.target, "0x")).to.be.revertedWithCustomError(f.coordinator, "UnauthorizedUpgrade")
		await f.coordinator.connect(f.upgrader).activate(f.admin.target, "0x")
		const migrated = await ethers.getContractAt("StorageMigrationTarget", f.proxyAddress)
		expect(await migrated.config()).to.equal(123)
		expect(await migrated.nonces(f.user.address)).to.equal(66)
		expect(await f.admin.owner()).to.equal(f.upgrader.address)
		await expect(f.coordinator.connect(f.upgrader).activate(f.admin.target, "0x")).to.be.revertedWithCustomError(f.coordinator, "InvalidMigration")
		const next = await (await ethers.getContractFactory("StorageMigrationTarget")).deploy()
		await f.admin.connect(f.upgrader).upgradeAndCall(f.proxyAddress, next.target, "0x")
		expect(await migrated.nonces(f.user.address)).to.equal(66)
	})

	it("rejects tampered commitments and rolls back a partially invalid chunk", async function () {
		const f = await fixture()
		const bad = { ...f.plan.items[1], value: ethers.toBeHex(99, 32) }
		await expect(f.migration.connect(f.importer).importStorage(0, [f.plan.items[0], bad])).to.be.revertedWithCustomError(f.migration, "InvalidEntry")
		expect((await f.migration.migrationProgress())[0]).to.equal(0)
		expect(await ethers.provider.getStorage(f.proxyAddress, f.plan.items[0].slot)).to.equal(ethers.ZeroHash)
	})

	it("rejects proxy and migration namespace slots even if they are committed", async function () {
		const dummy = await fixture()
		for (const slot of [
			ethers.toBeHex(BigInt(ethers.id("eip1967.proxy.implementation")) - 1n, 32),
			ethers.toBeHex(BigInt(ethers.id("eip1967.proxy.admin")) - 1n, 32),
			ethers.toBeHex(BigInt(ethers.id("eip1967.proxy.beacon")) - 1n, 32),
			await dummy.migration.PROGRESS_SLOT(),
		]) {
			const f = await fixture([{ slot, value: ethers.toBeHex(1, 32) }])
			await expect(f.migration.connect(f.importer).importStorage(0, f.plan.items)).to.be.revertedWithCustomError(f.migration, "ReservedSlot")
		}
	})
})
