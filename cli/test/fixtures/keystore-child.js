import process from "node:process";

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
			process.stdout.write("\nkeystore unlocked\n");
			process.exit(0);
		}
		value += String.fromCharCode(byte);
		process.stdout.write("*");
	}
});
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write("[hardhat-keystore] Enter the password: ");
