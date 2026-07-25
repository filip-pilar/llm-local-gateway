import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { grokCredentialsPath } from "./paths.mjs";

const GROK_OIDC_SCOPE =
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

export function readGrokAccessToken(path = grokCredentialsPath) {
  let descriptor;
  let source;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error(`Grok credential is not a regular file: ${path}`);
    }
    if ((metadata.mode & 0o777) !== 0o600) fchmodSync(descriptor, 0o600);
    source = readFileSync(descriptor, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot securely read the official Grok CLI session at ${path}. Run \`grok login\` first and ensure it is a regular mode-600 file.`,
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new Error(`The official Grok CLI session at ${path} is not valid JSON.`, {
      cause: error,
    });
  }
  const token = document?.[GROK_OIDC_SCOPE]?.key;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error(
      `The official Grok CLI session at ${path} has no xAI OIDC access token. Run \`grok login\` again.`,
    );
  }
  return token.trim();
}

export function refreshGrokOAuthSession({
  cliPath,
  env = process.env,
  run = spawnSync,
} = {}) {
  if (!cliPath) throw new Error("Official Grok CLI path is required");
  const childEnv = { ...env };
  delete childEnv.XAI_API_KEY;
  delete childEnv.GROK_API_KEY;
  const result = run(cliPath, ["--no-auto-update", "models"], {
    encoding: "utf8",
    env: childEnv,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result?.status !== 0) {
    const reason =
      result?.error?.code === "ETIMEDOUT" || result?.signal
        ? "timed out or was terminated"
        : `failed with exit ${result?.status ?? "unknown"}`;
    throw new Error(
      `The official Grok CLI could not refresh the xAI OAuth session: model discovery ${reason}. Run \`grok login\` again.`,
    );
  }
}

export function readGrokCLIVersion({
  cliPath,
  env = process.env,
  run = spawnSync,
} = {}) {
  if (!cliPath) throw new Error("Official Grok CLI path is required");
  const result = run(cliPath, ["version"], {
    encoding: "utf8",
    env,
    timeout: 5_000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
  });
  const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim();
  const match = /^grok\s+([0-9]+(?:\.[0-9]+){2})(?:\s|$)/i.exec(output);
  if (result?.status !== 0 || !match) {
    throw new Error(
      "The configured executable is not a supported official Grok CLI. Install it with `npm install -g @xai-official/grok`.",
    );
  }
  return match[1];
}
