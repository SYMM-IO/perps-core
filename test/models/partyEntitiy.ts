import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { BytesLike } from "ethers"

import { ethers } from "../helpers/hardhat-connection.js"
import { RunContext } from "./RunContext.js"

export class PartyEntity {
	constructor(
		protected context: RunContext,
		protected _signer: HardhatEthersSigner,
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
