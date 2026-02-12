import { accountLayerDiamondTask } from "./accountLayerDiamond.js"
import { deployAllTask } from "./deployAll.js"
import { diamondTask } from "./diamond.js"
import { feeDistributorTask } from "./feeDistributor.js"
import { instantLayerTask } from "./instantLayer.js"
import { multiaccountTask } from "./multiaccount.js"
import { multicallTask } from "./multicall.js"
import { partyBTask } from "./partyB.js"
import { signatureVerifierTask } from "./signatureVerifier.js"
import { stablecoinTask } from "./stablecoin.js"
import {
	checkDeploymentTask,
	verifyAccountTask,
	verifyAccountLayerTask,
	verifyAffiliateTask,
	verifyAllTask,
	verifyDeploymentTask,
	verifyInstantLayerTask,
} from "./verify.js"

export const deployTasks = [
	accountLayerDiamondTask,
	checkDeploymentTask,
	deployAllTask,
	diamondTask,
	feeDistributorTask,
	instantLayerTask,
	multiaccountTask,
	multicallTask,
	partyBTask,
	signatureVerifierTask,
	stablecoinTask,
	verifyAllTask,
	verifyDeploymentTask,
	verifyAccountLayerTask,
	verifyAffiliateTask,
	verifyAccountTask,
	verifyInstantLayerTask,
]
