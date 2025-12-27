import {expect} from "chai"
import type { BridgeTransactionStructOutput} from "../../../src/types/interfaces/ISymmio.js"
import {logger} from "../../utils/LoggerUtils.js"
import {BridgeTransactionStatus} from "../Enums.js"
import {RunContext} from "../RunContext.js"
import {TransactionValidator} from "./TransactionValidator.js"

export type WithdrawLockedTransactionValidatorBeforeArg = {
	bridge: string
	transactionId: bigint
}

export type WithdrawLockedTransactionValidatorBeforeOutput = {
	bridge: string
	depositBalanceBridge: bigint
	transaction: BridgeTransactionStructOutput
}

export type WithdrawLockedTransactionValidatorAfterArg = {
	transactionId: bigint
	beforeOutput: WithdrawLockedTransactionValidatorBeforeOutput
}

export class WithdrawLockedTransactionValidator implements TransactionValidator {
	async before(context: RunContext, arg: WithdrawLockedTransactionValidatorBeforeArg): Promise<WithdrawLockedTransactionValidatorBeforeOutput> {
		logger.debug("Before WithdrawLockedTransactionValidator...")
		return {
			bridge: arg.bridge,
			depositBalanceBridge: await context.viewFacet.balanceOf(arg.bridge),
			transaction: await context.viewFacet.getBridgeTransaction(arg.transactionId),
		}
	}

	async after(context: RunContext, arg: WithdrawLockedTransactionValidatorAfterArg) {
		logger.debug("After WithdrawLockedTransactionValidator...")

		// Check Transaction
		const transaction = await context.viewFacet.getBridgeTransaction(arg.transactionId)
		expect(transaction.status).to.be.equal(BridgeTransactionStatus.WITHDRAWN)
	}
}
