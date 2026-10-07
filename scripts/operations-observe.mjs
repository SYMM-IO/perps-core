import { telemetrySnapshot } from "../deployment-tooling/operations/telemetry.js";
import fs from "node:fs";

const [statePath, ...extra] = process.argv.slice(2);
if (!statePath || extra.length) throw new Error("Usage: node scripts/operations-observe.mjs <active-or-history-state.json>");
if (fs.statSync(statePath).size > 5 * 1024 * 1024) throw new Error("State exceeds 5 MiB");
console.log(JSON.stringify(telemetrySnapshot(JSON.parse(fs.readFileSync(statePath, "utf8"))), null, 2));
