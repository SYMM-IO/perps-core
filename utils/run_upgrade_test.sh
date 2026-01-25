npx hardhat node
python3 utils/update_sig_checks.py 1
npx hardhat run ./scripts/initializeUpgradeTest.ts --network localhost
python3 utils/update_sig_checks.py 0