import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { BytesLike } from "ethers"
import { ethers } from "../helpers/hardhat-connection"

import { RunContext } from "./RunContext"

export class PartyEntity {
	constructor(
		protected context: RunContext,
		protected _signer: SignerWithAddress,
	) {}

	public get signer() {
		return this._signer
	}

	public get address() {
		return this._signer.address
	}

	public async sign(hash: BytesLike): Promise<string> {
		return await this.signer.signMessage(ethers.getBytes(hash))
	}
}
