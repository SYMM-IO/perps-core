import { ethers } from "../test/helpers/hardhat-connection.js"

const DIAMOND_ADDRESS = "0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB"
const PARTY_B = "0xf62a670cda28FfAE65eE2a42D6cf6CF05EC5E775"
const SYMBOL_TYPE = 2n

const [signer] = await ethers.getSigners()
console.log("Signer:", signer.address)

const symbolControlFacet = await ethers.getContractAt(
	"contracts/core/facets/SymbolControl/SymbolControlFacet.sol:SymbolControlFacet",
	DIAMOND_ADDRESS,
	signer,
)

console.log(`Whitelisting symbol type ${SYMBOL_TYPE} for partyB ${PARTY_B}...`)

const tx = await symbolControlFacet.whitelistSymbolType(PARTY_B, SYMBOL_TYPE)
console.log("tx:", tx.hash)
await tx.wait()
console.log("Done!")
