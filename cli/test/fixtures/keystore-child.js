import process from "node:process";

const label = process.argv[2] || "keystore";
let value = "";
process.stdin.on("data", chunk => {
	for (const byte of chunk) {
		if (byte === 3) process.exit(130);
		if (byte === 10 || byte === 13) {
			process.stdin.setRawMode?.(false);
			if (value !== "test-password") {
				process.stderr.write("\nInvalid password\n");
				process.exit(1);
			}
			process.stdout.write(`\n${label} keystore unlocked\n`);
			setTimeout(() => process.stdout.write("Reading live templates\n"), 50);
			setTimeout(() => process.stdout.write("Plan complete. Review it, then rerun with EXECUTE=true CONFIRM_CHAIN_ID=42161.\n"), 100);
			setTimeout(() => {}, 900);
			return;
		}
		value += String.fromCharCode(byte);
		process.stdout.write("*");
	}
});
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write("[hardhat-keystore] Enter the password: ");
