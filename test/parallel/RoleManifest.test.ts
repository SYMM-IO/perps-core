import { expect } from "chai"
import fs from "node:fs"
import path from "node:path"

import { CORE_ADMIN_ROLES as DEPLOY_ADMIN_ROLES, DEPLOYER_SETUP_ROLES } from "../../tasks/deploy/deployAll.js"
import { CORE_ADMIN_ROLES as VERIFY_ADMIN_ROLES, CORE_PRIVILEGED_ROLES } from "../../tasks/deploy/verify.js"

// Role names are hashed strings off-chain, so nothing links the deploy lists to
// LibAccessibility.sol. This test keeps them from drifting apart.
describe("core role manifest", function () {
	const source = fs.readFileSync(path.join(process.cwd(), "contracts/core/libraries/LibAccessibility.sol"), "utf8")
	const onChain = new Set([...source.matchAll(/bytes32 public constant (\w+_ROLE) = keccak256\("(\w+)"\)/g)].map(m => m[2]))

	it("declares every constant with a matching string literal", function () {
		for (const m of source.matchAll(/bytes32 public constant (\w+_ROLE) = keccak256\("(\w+)"\)/g)) {
			expect(m[1]).to.equal(m[2])
		}
	})

	it("grants every non-service role to the admin in deployAll", function () {
		const serviceRoles = ["WITHDRAW_SPEED_UP_ROLE", "SOFT_LIQUIDATOR_ROLE", "CLEARING_HOUSE_ROLE", "VIRTUAL_DEPOSITOR_ROLE", "BALANCE_SETTLER_ROLE"]
		const expected = [...onChain].filter(r => r !== "DEFAULT_ADMIN_ROLE" && !serviceRoles.includes(r)).sort()
		expect([...DEPLOY_ADMIN_ROLES].sort()).to.deep.equal(expected)
		for (const role of DEPLOYER_SETUP_ROLES) expect(onChain.has(role), role).to.equal(true)
	})

	it("verifies exactly the on-chain role set", function () {
		expect([...VERIFY_ADMIN_ROLES].sort()).to.deep.equal([...DEPLOY_ADMIN_ROLES, "DEFAULT_ADMIN_ROLE"].sort())
		expect([...CORE_PRIVILEGED_ROLES].sort()).to.deep.equal([...onChain].sort())
	})
})
