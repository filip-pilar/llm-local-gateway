import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { devinCredentialsPath } from "./paths.mjs";

export function parseTomlString(source, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern =
    "^\\s*" +
    escapedKey +
    "\\s*=\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*')\\s*(?:#.*)?$";
  const match = source.match(
    new RegExp(pattern, "m"),
  );
  if (!match) return null;

  if (match[1].startsWith("'")) return match[1].slice(1, -1);
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function readDevinSessionToken(path = devinCredentialsPath) {
  let source;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error(`Devin credential is not a regular file: ${path}`);
    }
    if ((metadata.mode & 0o777) !== 0o600) fchmodSync(descriptor, 0o600);
    source = readFileSync(descriptor, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot securely read Devin credentials at ${path}. Run \`devin auth login\` first and ensure it is a regular mode-600 file.`,
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const token = parseTomlString(source, "windsurf_api_key")?.trim();
  if (!token) {
    throw new Error(
      `Devin credentials at ${path} do not contain a windsurf_api_key. Run \`devin auth login\` again.`,
    );
  }

  return token;
}
