import { createHash } from "node:crypto";
import { join } from "node:path";

export function swiftCachePaths(root, scratchName) {
  const checkoutKey = createHash("sha256")
    .update(root)
    .digest("hex")
    .slice(0, 12);
  return {
    moduleCache: join(root, ".build", `swift-module-cache-${checkoutKey}`),
    scratch: join(root, ".build", `${scratchName}-${checkoutKey}`),
  };
}
