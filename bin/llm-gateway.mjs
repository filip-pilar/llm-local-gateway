#!/usr/bin/env node
import { formatCliError, runCli } from "../src/interfaces/cli.mjs";

try {
  await runCli();
} catch (error) {
  process.stderr.write(`llm-gateway: ${formatCliError(error)}\n`);
  process.exitCode = 1;
}
