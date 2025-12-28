import { accountHubTask } from "./accountHub.js"
import { affiliateHubTask } from "./affiliateHub.js"
import { deployAllTask } from "./deployAll.js"
import { diamondTask } from "./diamond.js"
import { feeDistributorTask } from "./feeDistributor.js"
import { instantLayerTask } from "./instantLayer.js"
import { multiaccountTask } from "./multiaccount.js"
import { multicallTask } from "./multicall.js"
import { partyBTask } from "./partyB.js"
import { signatureVerifierTask } from "./signatureVerifier.js"
import { stablecoinTask } from "./stablecoin.js"
import { verifyAccountHubTask, verifyAffiliateHubTask, verifyDeploymentTask, verifyInstantLayerTask } from "./verify.js"

export const deployTasks = [
	accountHubTask,
	affiliateHubTask,
	deployAllTask,
	diamondTask,
	feeDistributorTask,
	instantLayerTask,
	multiaccountTask,
	multicallTask,
	partyBTask,
	signatureVerifierTask,
	stablecoinTask,
	verifyDeploymentTask,
	verifyAffiliateHubTask,
	verifyAccountHubTask,
	verifyInstantLayerTask,
]
