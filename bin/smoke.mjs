#!/usr/bin/env node
import { runCli, formatCliError } from "../src/interfaces/cli.mjs";

try {
  await runCli(["smoke", ...process.argv.slice(2)]);
} catch (error) {
  process.stderr.write(`smoke: ${formatCliError(error)}\n`);
  process.exitCode = 1;
}
