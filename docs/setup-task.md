## Step 1: System deploy

Deploy the core system contracts and run the initial setup:
```bash
npx hardhat deploy:system --admin <ADDRESS> --symmiofeereceiver <ADDRESS> --setup true
```

Parameters:
- `--admin`: Admin address for the system deployment
- `--symmiofeereceiver`: Fee receiver address for Symmio
- `--setup`: When `true`, runs the post-deploy setup routine

Set `PRIVATE_KEY` in `.env` and make sure it matches the `--admin` address.

## Step 2: Deploy PartyB Contract

After the system contracts are deployed, deploy a PartyB contract:

```bash
npx hardhat deploy:symmioPartyB \
  --admin <ADMIN_ADDRESS> \
  --symmioaddress <DIAMOND_ADDRESS> \
  --network <NETWORK_NAME>
```

Parameters:
- `--admin`: Admin address for the PartyB contract
- `--symmioaddress`: Address of the deployed Diamond contract (from Step 1)
- `--network`: Same network used in Step 1

Important notes:
- `<DIAMOND_ADDRESS>` is output from Step 1's deployment report
- You can find it in the generated `deployment-report-*.json` file or in the console output
- PartyB must be deployed to the same network as the system contracts
