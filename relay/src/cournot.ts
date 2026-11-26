import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/cursor-plugin/skills/cournot/scripts/cournot-client.mjs",
);

const GOLD_DOWN = {
  message: "XAUt gold price in the next 24 hours",
  marketId: "24318246",
};

/** Cournot probability that gold finishes down, from the bundled client. */
export function cournotGoldDownProbability(): Promise<number> {
  const request = Buffer.from(
    JSON.stringify({ message: GOLD_DOWN.message, market_ids: [GOLD_DOWN.marketId] }),
  ).toString("base64");
  return new Promise((resolveProbability, reject) => {
    const child = spawn(process.execPath, [CLIENT, "prepare", "--request-base64", request], {
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || "Cournot did not return a probability."));
        return;
      }
      try {
        const parsed = JSON.parse(out) as { response?: { data?: { probability?: number } } };
        const probability = parsed.response?.data?.probability;
        if (typeof probability !== "number") {
          reject(new Error("Cournot did not return a probability."));
          return;
        }
        resolveProbability(probability);
      } catch {
        reject(new Error("Cournot did not return a probability."));
      }
    });
  });
}
