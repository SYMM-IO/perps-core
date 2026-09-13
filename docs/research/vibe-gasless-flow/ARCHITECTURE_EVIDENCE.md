# Architecture evidence

Source confidence is separate from deployed/runtime verification.

| ID  | Component / claim                                                    | Source                                                                            | Confidence      |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------- |
| F1  | Deployment and service configuration                                 | `Vibe public bundle (formatted snapshot)/0hxgr-icwjqqt.js:1072`                   | Verified source |
| F2  | Gasless operation submit, poll, replay and nonce helpers             | `Vibe public bundle (formatted snapshot)/1cet55mc7q5bs.js:1098`                   | Verified source |
| F3  | Deposit configuration reads, wallet getter, payload and HTTP helpers | `Vibe public bundle (formatted snapshot)/30rrs35bigwub.js:2290`                   | Verified source |
| F4  | Deposit callbacks and new-account readiness                          | `Vibe public bundle (formatted snapshot)/3sa7q1lsq8r4x.js:17644`                  | Verified source |
| F5  | Enigma endpoints, notifications, VA enumeration and Core positions   | `Vibe public bundle (formatted snapshot)/3v4bnixzhlss2.js:1279`                   | Verified source |
| F6  | Open/close construction, close settlement wait and margin sweep      | `Vibe public bundle (formatted snapshot)/4210gwrj0ffk-.js:1483`                   | Verified source |
| S1  | Operation API acceptance and status                                  | `gaslessq-service/services/operation-api/src/operation_api/main.py:329`           | Verified source |
| S2  | Deposit API acceptance and status                                    | `gaslessq-service/services/deposit-api/src/deposit_api/main.py:310`               | Verified source |
| S3  | Executor and receipt finalization                                    | `gaslessq-service/services/executor-worker/src/executor_worker/main.py:1044`      | Verified source |
| S4  | Chain reads, simulation, transaction sending and encoding            | `gaslessq-service/packages/gaslessq_shared/src/gaslessq_shared/chain.py:464`      | Verified source |
| S5  | Receipt/attempt persistence                                          | `gaslessq-service/packages/gaslessq_shared/src/gaslessq_shared/repository.py:395` | Verified source |
| S7  | Service configuration defaults                                       | `gaslessq-service/packages/gaslessq_shared/src/gaslessq_shared/config.py:250`     | Verified source |
| S9  | Named-instance service edge routing                                  | `gaslessq-service/docs/architecture.md:77`                                        | Verified source |
| S10 | Worker deposit calculation still omits wallet creation fee           | `gaslessq-service/services/executor-worker/src/executor_worker/main.py:636`       | Verified source |
| S11 | Native top-up signature validator requires 65 bytes                  | `gaslessq-service/packages/gaslessq_shared/src/gaslessq_shared/models.py:642`     | Verified source |
| C1  | Gasless relay/deposit dispatch, indexed wallet API and fees          | `perps-core/contracts/gaslessLayer/GaslessLayer.sol:152`                          | Verified source |
| C2  | InstantLayer execution and authorization                             | `perps-core/contracts/instantLayer/InstantLayer.sol:943`                          | Verified source |
| C3  | AccountLayer routing                                                 | `perps-core/contracts/accountLayer/facets/Core/CoreFacet.sol:282`                 | Verified source |
| C4  | Core operational fee collection                                      | `perps-core/contracts/core/libraries/LibOperationalFee.sol:62`                    | Verified source |
| C5  | Core collateral transfer and 18-decimal credit                       | `perps-core/contracts/core/facets/Account/AccountFacetImpl.sol:23`                | Verified source |
| C6  | Core operational allowance getter                                    | `perps-core/contracts/core/facets/ViewFacet/ViewFacet.sol:264`                    | Verified source |
| C7  | Current GaslessLayer events                                          | `perps-core/contracts/gaslessLayer/interfaces/IGaslessLayer.sol:17`               | Verified source |
| C8  | Creation fees and unified quote/cap entrypoints                      | `perps-core/contracts/gaslessLayer/GaslessLayer.sol:352`                          | Verified source |
| C9  | Quote dispatch, actual charge accounting and rollback result         | `perps-core/contracts/gaslessLayer/libraries/GaslessFeeQuoteLib.sol:200`          | Verified source |
| C10 | Signed salt fee-cap layout and enforcement                           | `perps-core/contracts/gaslessLayer/libraries/GaslessFeeLimits.sol:6`              | Verified source |
| C11 | Native top-up capped signature and charge enforcement                | `perps-core/contracts/gaslessLayer/libraries/GaslessNativeGasTopUpLib.sol:133`    | Verified source |
| C12 | TypeScript quote decoder and signing helpers                         | `perps-core/scripts/gaslessLayer/fee-quote.ts:32`                                 | Verified source |
| C13 | library deployment graph                                             | `perps-core/scripts/gaslessLayer/layer-libraries.ts:49`                           | Verified source |
| C14 | Upgrade zero-fee preservation and client handoff policy              | `perps-core/tasks/deploy/accountInstantUpgrade.ts:630`                            | Verified source |
| C18 | Withdrawal execution in the linked fee library                       | `perps-core/contracts/gaslessLayer/libraries/GaslessFeeQuoteLib.sol:41`           | Verified source |
| C19 | Upgrade workflow v8 and client readiness                             | `perps-core/cli/tasks/account-instant-upgrade.js:184`                             | Verified source |
| C16 | Owner withdrawal and caller-bound wallet selection                   | `perps-core/contracts/gaslessLayer/GaslessLayer.sol:330`                          | Verified source |
| C17 | Administrative non-collateral recovery without fees                  | `perps-core/contracts/gaslessLayer/GaslessLayer.sol:547`                          | Verified source |
| C15 | Deposit sweep and net-credit calculation                             | `perps-core/contracts/gaslessLayer/libraries/GaslessFeeQuoteLib.sol:67`           | Verified source |
| S12 | Deposit receipt finalization                                         | `gaslessq-service/services/executor-worker/src/executor_worker/main.py:704`       | Verified source |

Unverified: Vibe proxy upstream mapping; Enigma assembly/notification producer; deployed ABI, settings, roles and finality; a specific live settlement.
