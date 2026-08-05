import { ethers } from "../../test/helpers/hardhat-connection.js"
import { writeTxOverrides } from "./utils/txOverrides.js"

const [signer] = await ethers.getSigners()
const to = ethers.Wallet.createRandom().address

console.log(`from: ${signer.address}`)
console.log(`to:   ${to}`)

const t0 = performance.now()
const tx = await signer.sendTransaction({ to, value: 1n, ...writeTxOverrides() })
const tSent = performance.now()
console.log(`tx hash: ${tx.hash}  (submit: ${(tSent - t0).toFixed(0)} ms)`)

const receipt = await tx.wait()
const tMined = performance.now()

console.log(`block: ${receipt!.blockNumber}  gasUsed: ${receipt!.gasUsed}`)
console.log(`mined in: ${(tMined - tSent).toFixed(0)} ms`)
console.log(`total:    ${(tMined - t0).toFixed(0)} ms`)
