export type VanityGroup = "diamonds" | "facets" | "libraries" | "peripherals"

export declare const VANITY_GROUPS: readonly VanityGroup[]
export declare const DEPLOYABLE_CONTRACTS: Readonly<Record<string, VanityGroup>>
export declare function deployableGroup(key: string): VanityGroup | undefined
