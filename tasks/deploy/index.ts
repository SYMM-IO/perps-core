import { accountLayerDiamondTask } from "./accountLayerDiamond.js"
import { checkComponentTask } from "./checkComponent.js"
import { checkStandaloneDeploymentTask } from "./checkStandaloneDeployment.js"
import { create2FactoryTask } from "./create2Factory.js"
import { deployAllTask } from "./deployAll.js"
import { deployComponentTask } from "./deployComponent.js"
import { diamondTask } from "./diamond.js"
import { feeDistributorTask } from "./feeDistributor.js"
import { enableBigBlocksTask, disableBigBlocksTask } from "./hyperevm.js"
import { instantLayerTask } from "./instantLayer.js"
import { liquidatorTask } from "./liquidator.js"
import { completeLocalHandoverTask } from "./localHandover.js"
import { multiaccountTask } from "./multiaccount.js"
import { multicallTask } from "./multicall.js"
import { partyBTask } from "./partyB.js"
import { reconcileTransactionsTask } from "./reconcileTransactions.js"
import { proposeSafeBatchTask } from "./safeProposal.js"
import { signatureVerifierTask } from "./signatureVerifier.js"
import { stablecoinTask } from "./stablecoin.js"
import { grantSymbolManagerDiamondRolesTask, grantSymbolManagerOperatorRolesTask, symbolManagerTask } from "./symbolManager.js"
import { upgradeProxyTask } from "./upgrade.js"
import { checkDeploymentTask, verifyAllTask } from "./verify.js"

export const deployTasks = [
	accountLayerDiamondTask,
	checkComponentTask,
	checkStandaloneDeploymentTask,
	checkDeploymentTask,
	create2FactoryTask,
	deployAllTask,
	deployComponentTask,
	diamondTask,
	disableBigBlocksTask,
	enableBigBlocksTask,
	feeDistributorTask,
	instantLayerTask,
	liquidatorTask,
	completeLocalHandoverTask,
	multiaccountTask,
	multicallTask,
	partyBTask,
	proposeSafeBatchTask,
	reconcileTransactionsTask,
	signatureVerifierTask,
	stablecoinTask,
	symbolManagerTask,
	grantSymbolManagerDiamondRolesTask,
	grantSymbolManagerOperatorRolesTask,
	upgradeProxyTask,
	verifyAllTask,
]
