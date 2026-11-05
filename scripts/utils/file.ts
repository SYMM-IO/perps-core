import fs from "fs"

export type Addresses = {
	symmioAddress?: string
	collateralAddress?: string
	multiAccountAddress?: string
	hedgerProxyAddress?: string
	MulticallAddress?: string
}

export function loadAddresses(): Addresses {
	const filePath = "./output/addresses.json"
	if (!fs.existsSync(filePath)) return {}
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"))
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected a JSON object")
		return parsed as Addresses
	} catch (error) {
		throw new Error(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

export function saveAddresses(content: Addresses): void {
	const directory = "./output"
	const filePath = `${directory}/addresses.json`
	if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true })
	const temporaryPath = `${filePath}.${process.pid}.tmp`
	fs.writeFileSync(temporaryPath, `${JSON.stringify(content, null, 2)}\n`)
	fs.renameSync(temporaryPath, filePath)
}
