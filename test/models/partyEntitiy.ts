import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { RunContext } from "./RunContext"
import { ethers } from "hardhat"
import { BytesLike } from "ethers"


export class PartyEntity {
	constructor(
		protected context: RunContext,
		protected signer: SignerWithAddress,
	) {}


	public get getSigner() {
		return this.signer
	}

	public get address() {
		return this.signer.address
	}

	public async sign(hash: BytesLike): Promise<string> {
		return await this.getSigner.signMessage(ethers.getBytes(hash))
	}
}
