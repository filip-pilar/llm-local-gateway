import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

function writePrivateJsonAtomic(path, value) {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

export function scrubUpstreamPolicySamples(dataDir) {
  const statsPath = join(dataDir, "stats.json");
  let descriptor;
  let stats;
  try {
    descriptor = openSync(
      statsPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error(`Refusing unsafe upstream stats file: ${statsPath}`);
    }
    if ((metadata.mode & 0o777) !== 0o600) fchmodSync(descriptor, 0o600);
    stats = JSON.parse(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { statsPath, removed: 0 };
    if (error?.message?.startsWith("Refusing unsafe upstream stats file:")) {
      throw error;
    }
    if (error?.code === "ELOOP") {
      throw new Error(`Refusing unsafe upstream stats file: ${statsPath}`, {
        cause: error,
      });
    }
    throw new Error(`Cannot parse upstream stats state at ${statsPath}`, {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
    throw new Error(`Upstream stats state must be an object: ${statsPath}`);
  }
  const policyBlocks = stats.recentPolicyBlocks;
  const removed = Array.isArray(policyBlocks)
    ? policyBlocks.length
    : policyBlocks == null
      ? 0
      : 1;
  if (removed === 0) return { statsPath, removed: 0 };

  writePrivateJsonAtomic(statsPath, {
    ...stats,
    recentPolicyBlocks: [],
  });
  return { statsPath, removed };
}

export function reconcileUpstreamAccounts(dataDir, currentToken) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dataDir);
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error(`Refusing unsafe upstream state directory: ${dataDir}`);
  }
  if ((directory.mode & 0o777) !== 0o700) chmodSync(dataDir, 0o700);

  const accountsPath = join(dataDir, "accounts.json");
  if (!existsSync(accountsPath)) {
    try {
      writeFileSync(accountsPath, "[]\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(accountsPath, 0o600);
      return { accountsPath, removed: 0, retained: 0 };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  let accounts;
  let descriptor;
  try {
    descriptor = openSync(
      accountsPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error(`Refusing unsafe upstream accounts file: ${accountsPath}`);
    }
    if ((metadata.mode & 0o777) !== 0o600) fchmodSync(descriptor, 0o600);
    accounts = JSON.parse(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error?.message?.startsWith("Refusing unsafe upstream accounts file:")) {
      throw error;
    }
    if (error?.code === "ELOOP") {
      throw new Error(`Refusing unsafe upstream accounts file: ${accountsPath}`, {
        cause: error,
      });
    }
    throw new Error(`Cannot parse upstream accounts state at ${accountsPath}`, {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (!Array.isArray(accounts)) {
    throw new Error(`Upstream accounts state must be an array: ${accountsPath}`);
  }

  const matching = accounts.filter((account) => account?.apiKey === currentToken);
  const retained = matching.slice(0, 1);
  const removed = accounts.length - retained.length;
  if (removed === 0) {
    return { accountsPath, removed, retained: retained.length };
  }

  writePrivateJsonAtomic(accountsPath, retained);
  return { accountsPath, removed, retained: retained.length };
}
