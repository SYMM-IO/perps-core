import { Contract, FetchRequest, JsonRpcProvider, ZeroAddress, id, keccak256 } from "ethers";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		deployment: { type: "string", multiple: true },
		output: { type: "string" },
		"quote-limit": { type: "string", default: "0" },
		"all-quotes": { type: "boolean", default: false },
	},
});
assert(
	values.deployment?.length && values.output,
	"Usage: node scripts/audit/inspect-deployment.mjs --deployment <address-book-id> --output <report.json> [--quote-limit 128]",
);
const quoteLimit = Number(values["quote-limit"]);
assert(Number.isSafeInteger(quoteLimit) && quoteLimit >= 0 && quoteLimit <= 1000, "quote-limit must be 0..1000");
const book = JSON.parse(readFileSync("addresses.json", "utf8"));
const abi = name => JSON.parse(readFileSync(`abis/${name}.json`, "utf8"));
const loupeAbi = ["function facets() view returns ((address facetAddress,bytes4[] functionSelectors)[])"];
const report = {
	addressBookChecked: book.checked,
	deployments: [],
	purpose: "Read-only pre-upgrade inventory; no transactions or signatures are created.",
};

async function read(contract, name, args, blockTag) {
	try {
		return { ok: true, value: await contract.getFunction(name).staticCall(...args, { blockTag }) };
	} catch (error) {
		return { ok: false, error: error.shortMessage ?? error.code ?? "read failed" };
	}
}

for (const deploymentId of values.deployment) {
	const entry = book.deployments.find(item => item.id === deploymentId);
	assert(entry, `Unknown address-book deployment ${deploymentId}`);
	const chain = book.chains[entry.chain];
	assert(chain?.rpc, `No public RPC configured for ${entry.chain}`);
	const request = new FetchRequest(process.env.AUDIT_RPC_URL || chain.rpc);
	request.timeout = 20_000;
	const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
	const deployment = { id: deploymentId, chainId: chain.chainId, addressBookVersion: entry.version, contracts: {}, reads: {}, limitations: [] };
	report.deployments.push(deployment);
	console.log(`Inspecting ${deploymentId} (read-only)`);
	try {
		assert.equal(Number((await provider.getNetwork()).chainId), chain.chainId, "RPC chain mismatch");
		const blockTag = await provider.getBlockNumber();
		const block = await provider.getBlock(blockTag);
		deployment.blockNumber = blockTag;
		deployment.blockHash = block.hash;
		for (const name of ["core", "accountLayer", "instantLayer", "verifier", "express", "gasless"]) {
			const address = entry.contracts[name];
			if (!address) continue;
			const code = await provider.getCode(address, blockTag);
			deployment.contracts[name] = { address, hasCode: code !== "0x", codeHash: keccak256(code) };
			if (["core", "accountLayer", "instantLayer"].includes(name)) {
				const facets = await read(new Contract(address, loupeAbi, provider), "facets", [], blockTag);
				deployment.contracts[name].facets = facets.ok
					? facets.value.map(facet => ({ address: facet.facetAddress, selectors: [...facet.functionSelectors] }))
					: facets;
			}
		}
		const core = new Contract(entry.contracts.core, abi("symmio"), provider);
		const instant = new Contract(entry.contracts.instantLayer, abi("instantLayer"), provider);
		const account = new Contract(entry.contracts.accountLayer, abi("accountLayer"), provider);
		for (const name of ["getMuonIds", "getMuonConfig", "getNextQuoteId", "coolDownsOfMA"])
			deployment.reads[name] = await read(core, name, [], blockTag);
		deployment.reads.coreAuthority = [];
		for (const component of ["accountLayer", "instantLayer", "gasless"]) {
			if (!entry.contracts[component]) continue;
			for (const role of ["COOLDOWN_ADMIN_ROLE", "SIGNER_ADMIN_ROLE", "INSTANT_LAYER_ROLE", "BALANCE_SETTLER_ROLE"]) {
				deployment.reads.coreAuthority.push({
					component,
					role,
					...(await read(core, "hasRole", [entry.contracts[component], id(role)], blockTag)),
				});
			}
		}
		deployment.reads.accountOwnershipEpochGetter = await read(account, "getAccountOwnershipEpoch", [ZeroAddress], blockTag);
		deployment.reads.delegationEpochGetter = await read(instant, "delegationOwnershipEpoch", [ZeroAddress, ZeroAddress, "0x00000000"], blockTag);
		deployment.reads.instantCore = await read(instant, "symmio", [], blockTag);
		deployment.reads.instantAccountLayer = await read(instant, "accountLayer", [], blockTag);
		deployment.reads.knownTargets = [];
		for (const component of ["core", "accountLayer", "gasless", "express"]) {
			if (entry.contracts[component])
				deployment.reads.knownTargets.push({
					component,
					...(await read(instant, "whitelistedTargets", [entry.contracts[component]], blockTag)),
				});
		}
		const count = await read(instant, "getNextTemplateId", [], blockTag);
		deployment.reads.templateCount = count;
		deployment.reads.templates = [];
		if (count.ok) {
			const limit = Math.min(Number(count.value), 64);
			for (let index = 0; index < limit; index++) {
				const template = await read(instant, "getTemplate", [index], blockTag);
				deployment.reads.templates.push({
					id: index,
					template: template.ok
						? {
								name: template.value.name,
								active: template.value.active,
								operations: template.value.operations.map(op => ({
									insertionPoints: [...op.insertionPoints],
									sourceIndices: [...op.sourceIndices],
									sourceOffsets: [...op.sourceOffsets],
								})),
							}
						: template,
					instantOpenMode: await read(instant, "templateInstantOpenMode", [index], blockTag),
				});
			}
			if (Number(count.value) > limit)
				deployment.limitations.push("Template inventory capped at 64; remaining templates need a separate pass.");
		}
		if (entry.contracts.verifier) {
			const verifier = new Contract(
				entry.contracts.verifier,
				["function getAllPublicKeys() view returns ((uint256 x,uint8 parity)[])"],
				provider,
			);
			const keys = await read(verifier, "getAllPublicKeys", [], blockTag);
			const halfQ = (0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n >> 1n) + 1n;
			deployment.reads.muonKeys = keys.ok
				? keys.value.map(key => ({ x: key.x, parity: key.parity, validRange: key.x > 0n && key.x < halfQ && key.parity <= 1n }))
				: keys;
		}
		const lastId = deployment.reads.getNextQuoteId;
		deployment.quoteScan = { requestedLimit: values["all-quotes"] ? "all" : quoteLimit, scanned: 0, candidates: [], liquidatingAccounts: [] };
		if ((quoteLimit || values["all-quotes"]) && lastId.ok) {
			const first = values["all-quotes"] || lastId.value < BigInt(quoteLimit) ? 1n : lastId.value - BigInt(quoteLimit) + 1n;
			assert(lastId.value - first + 1n <= 1_000_000n, "Large quote history requires a separately scoped/indexed scan");
			deployment.quoteScan.firstId = first;
			deployment.quoteScan.lastId = lastId.value;
			const accounts = new Map();
			const quotes = new Map();
			for (let quoteId = first; quoteId <= lastId.value; quoteId++) {
				if ((quoteId - first) % 32n === 0n) {
					const count = Number(lastId.value - quoteId + 1n < 32n ? lastId.value - quoteId + 1n : 32n);
					const batch = await read(
						core,
						"getQuotesWithBitmap",
						[{ size: count, elements: [{ offset: quoteId, bitmap: (1n << BigInt(count)) - 1n }] }, 100_000],
						blockTag,
					);
					quotes.clear();
					if (batch.ok)
						for (let index = 0; index < count; index++) {
							const expectedId = quoteId + BigInt(index);
							if (batch.value[index]?.id === expectedId) quotes.set(expectedId, batch.value[index]);
						}
				}
				const result = quotes.has(quoteId) ? { ok: true, value: quotes.get(quoteId) } : await read(core, "getQuote", [quoteId], blockTag);
				if (!result.ok) {
					deployment.quoteScan.candidates.push({ quoteId, readError: result });
					continue;
				}
				deployment.quoteScan.scanned++;
				const quote = result.value;
				if (quote.partyA === ZeroAddress || quote.id !== quoteId) {
					deployment.quoteScan.candidates.push({
						quoteId,
						readError: { ok: false, error: "Assigned quote ID returned an empty or mismatched record" },
					});
					continue;
				}
				if ([3n, 7n, 9n].includes(quote.quoteStatus)) continue;
				if (!accounts.has(quote.partyA)) {
					accounts.set(quote.partyA, {
						pending: await read(core, "getPartyAPendingQuotes", [quote.partyA], blockTag),
						liquidating: await read(core, "isPartyALiquidated", [quote.partyA], blockTag),
					});
				}
				const state = accounts.get(quote.partyA);
				if (quote.quoteStatus <= 2n && state.pending.ok && !state.pending.value.includes(quoteId)) {
					deployment.quoteScan.candidates.push({
						quoteId,
						partyA: quote.partyA,
						partyB: quote.partyB,
						status: quote.quoteStatus,
						reason: "Pending-status quote absent from the PartyA pending array; investigate historical atomic bookkeeping.",
					});
				}
			}
			for (const [address, state] of accounts)
				if (state.liquidating.ok && state.liquidating.value)
					deployment.quoteScan.liquidatingAccounts.push({
						address,
						detail: await read(core, "getLiquidatedStateOfPartyA", [address], blockTag),
					});
			deployment.quoteScan.accounts = [...accounts].map(([address, state]) => ({ address, ...state }));
			deployment.quoteScan.completeAssignedIdRange =
				first === 1n &&
				deployment.quoteScan.scanned === Number(lastId.value) &&
				!deployment.quoteScan.candidates.some(item => item.readError);
		}
		deployment.limitations.push(
			"The quote scan covers only the declared ID range and current stored records; ownership transfers, historical payments, and original liquidation buckets still require historical evidence.",
		);
		deployment.limitations.push(
			"Role and whitelist checks cover known configured addresses only; full role/target and ownership-transfer history requires deployment blocks and indexed/archive logs.",
		);
		deployment.limitations.push(
			"The address book does not identify every global relayer, and source/account-manager trust pairs require an operator inventory.",
		);
		deployment.limitations.push(
			"Selector presence and runtime hashes identify installed code; they do not independently prove that a deployed facet contains each audited fix.",
		);
		const finalBlock = await provider.getBlock(blockTag);
		assert.equal(finalBlock?.hash, block.hash, "Selected block changed during inventory; discard this snapshot");
		deployment.requiredReadFailures = [];
		function collectFailures(value, key) {
			if (!value || typeof value !== "object") return;
			if (value.ok === false) {
				deployment.requiredReadFailures.push({ path: key, error: value.error });
				return;
			}
			for (const [name, nested] of Object.entries(value)) collectFailures(nested, `${key}.${name}`);
		}
		for (const [name, contract] of Object.entries(deployment.contracts)) {
			if (!contract.hasCode) deployment.requiredReadFailures.push({ path: `contracts.${name}`, error: "Configured address has no bytecode" });
			collectFailures(contract.facets, `contracts.${name}.facets`);
		}
		for (const [name, value] of Object.entries(deployment.reads)) {
			if (!["accountOwnershipEpochGetter", "delegationEpochGetter"].includes(name)) collectFailures(value, `reads.${name}`);
		}
		collectFailures(deployment.quoteScan, "quoteScan");
		deployment.status = deployment.requiredReadFailures.length ? "incomplete" : "declared reads complete";
	} catch (error) {
		deployment.error = error.shortMessage ?? error.code ?? "inventory failed";
		deployment.status = "incomplete";
	} finally {
		provider.destroy();
		console.log(`${deploymentId}: ${deployment.status}, block ${deployment.blockNumber ?? "unavailable"}`);
	}
}
mkdirSync(path.dirname(values.output), { recursive: true });
writeFileSync(values.output, `${JSON.stringify(report, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`);
console.log(`Inventory saved to ${values.output}`);
if (report.deployments.some(item => item.status === "incomplete")) process.exitCode = 1;
