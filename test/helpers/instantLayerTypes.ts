import type {
	AccountStruct as AccountStructType,
	FlexFieldStruct as FlexFieldStructType,
	IInstantLayerDiamond,
	OperationStruct as OperationStructType,
	SignedOperationStruct as SignedOperationStructType,
} from "../../src/types/instantLayer/interfaces/IInstantLayerDiamond.js"

/** The InstantLayer diamond, typed through its composite interface. */
export type InstantLayer = IInstantLayerDiamond

// Struct types under the names the suites already use: InstantLayer.SignedOperationStruct and so on.
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace InstantLayer {
	export type AccountStruct = AccountStructType
	export type FlexFieldStruct = FlexFieldStructType
	export type OperationStruct = OperationStructType
	export type SignedOperationStruct = SignedOperationStructType
}
