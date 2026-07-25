#!/usr/bin/env node
import {
  formatGrokAuthProbe,
  probeOfficialGrokCLI,
} from "../src/spike/grok-auth.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => !["--json"].includes(arg))) {
  process.stderr.write("Usage: npm run spike:grok-auth -- [--json]\n");
  process.exitCode = 1;
} else {
  const report = probeOfficialGrokCLI();
  process.stdout.write(args.includes("--json")
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatGrokAuthProbe(report)}\n`);
  if (!report.ready_for_live_verification) process.exitCode = 1;
}
