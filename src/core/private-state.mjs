import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";

export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing unsafe bridge data directory: ${path}`);
  }
  if ((metadata.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

export function removeLegacyGatewayKey(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Refusing unsafe legacy gateway key: ${path}`);
  }
  rmSync(path);
  return true;
}
