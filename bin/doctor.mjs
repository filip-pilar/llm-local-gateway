#!/usr/bin/env node
import { runCli, formatCliError } from "../src/interfaces/cli.mjs";

try {
  await runCli(["status", ...process.argv.slice(2)]);
} catch (error) {
  process.stderr.write(`status: ${formatCliError(error)}\n`);
  process.exitCode = 1;
}
