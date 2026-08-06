import { accountLayerDiamondTask } from "./accountLayerDiamond.js"
import { checkComponentTask } from "./checkComponent.js"
import { create2FactoryTask } from "./create2Factory.js"
import { deployAllTask } from "./deployAll.js"
import { deployComponentTask } from "./deployComponent.js"
import { diamondTask } from "./diamond.js"
import { feeDistributorTask } from "./feeDistributor.js"
import { enableBigBlocksTask, disableBigBlocksTask } from "./hyperevm.js"
import { instantLayerTask } from "./instantLayer.js"
import { liquidatorTask } from "./liquidator.js"
import { multiaccountTask } from "./multiaccount.js"
import { multicallTask } from "./multicall.js"
import { partyBTask } from "./partyB.js"
import { signatureVerifierTask } from "./signatureVerifier.js"
import { stablecoinTask } from "./stablecoin.js"
import { grantSymbolManagerDiamondRolesTask, grantSymbolManagerOperatorRolesTask, symbolManagerTask } from "./symbolManager.js"
import { upgradeProxyTask } from "./upgrade.js"
import { checkDeploymentTask, verifyAllTask } from "./verify.js"

export const deployTasks = [
	accountLayerDiamondTask,
	checkComponentTask,
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
	multiaccountTask,
	multicallTask,
	partyBTask,
	signatureVerifierTask,
	stablecoinTask,
	symbolManagerTask,
	grantSymbolManagerDiamondRolesTask,
	grantSymbolManagerOperatorRolesTask,
	upgradeProxyTask,
	verifyAllTask,
]
