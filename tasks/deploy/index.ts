import { accountLayerDiamondTask } from "./accountLayerDiamond.js"
import { deployAllTask } from "./deployAll.js"
import { diamondTask } from "./diamond.js"
import { feeDistributorTask } from "./feeDistributor.js"
import { instantLayerTask } from "./instantLayer.js"
import { multiaccountTask } from "./multiaccount.js"
import { multicallTask } from "./multicall.js"
import { partyBTask } from "./partyB.js"
import { stablecoinTask } from "./stablecoin.js"
import { verifyAccountHubTask, verifyAccountLayerTask, verifyAffiliateHubTask, verifyDeploymentTask, verifyInstantLayerTask } from "./verify.js"

export const deployTasks = [
	accountLayerDiamondTask,
	deployAllTask,
	diamondTask,
	feeDistributorTask,
	instantLayerTask,
	multiaccountTask,
	multicallTask,
	partyBTask,
	stablecoinTask,
	verifyDeploymentTask,
	verifyAccountLayerTask,
	verifyAffiliateHubTask,
	verifyAccountHubTask,
	verifyInstantLayerTask,
]
