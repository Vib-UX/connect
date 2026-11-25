import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HostKind, ConnectId, ConnectIdentity } from "./types.js";

function dataDir(host: HostKind): string {
  const override = process.env.CONNECT_DATA_DIR;
  if (override) return override;
  const base =
    process.env.CLAUDE_PLUGIN_DATA ??
    process.env.CURSOR_PLUGIN_DATA ??
    join(homedir(), ".connect");
  return join(base, host);
}

function newConnectId(): ConnectId {
  return `conn_${randomBytes(4).toString("hex")}` as ConnectId;
}

/** One owner per app on this machine, shared by every socket that app opens. */
function machineOwner(host: HostKind): string {
  const path = join(homedir(), ".connect", "machine.json");
  mkdirSync(join(homedir(), ".connect"), { recursive: true });
  let id = "";
  if (existsSync(path)) {
    try {
      id = String((JSON.parse(readFileSync(path, "utf8")) as { id?: string }).id ?? "");
    } catch {
      id = "";
    }
  }
  if (!id) {
    id = randomBytes(8).toString("hex");
    writeFileSync(path, JSON.stringify({ id }));
  }
  return `${host}:${id}`;
}

/** The identity file this process holds, so saves go back to the same slot. */
let heldPath: string | null = null;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Claim the first identity slot no live process holds. The relay keeps one
 * socket per id, so two windows sharing an id would keep kicking each other off.
 */
function claimSlot(dir: string): string {
  for (let slot = 1; ; slot++) {
    const path = join(dir, slot === 1 ? "identity.json" : `identity-${slot}.json`);
    const lock = `${path}.lock`;
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
    } catch {
      const owner = Number(readFileSync(lock, "utf8"));
      if (owner !== process.pid && alive(owner)) continue;
      writeFileSync(lock, String(process.pid));
    }
    process.once("exit", () => {
      try {
        if (Number(readFileSync(lock, "utf8")) === process.pid) unlinkSync(lock);
      } catch {
        /* ignore */
      }
    });
    return path;
  }
}

export function loadOrCreateIdentity(
  host: HostKind,
  displayName?: string,
): ConnectIdentity {
  const dir = dataDir(host);
  mkdirSync(dir, { recursive: true });
  const path = claimSlot(dir);
  heldPath = path;

  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ConnectIdentity;
    let changed = false;
    if (displayName && displayName !== raw.displayName) {
      raw.displayName = displayName;
      changed = true;
    }
    if (!raw.chainId || raw.chainId === 8453 || raw.chainId === 10) {
      raw.chainId = 97;
      changed = true;
    }
    const owner = machineOwner(host);
    if (raw.owner !== owner) {
      raw.owner = owner;
      changed = true;
    }
    if (changed) writeFileSync(path, JSON.stringify(raw, null, 2));
    return raw;
  }

  const identity: ConnectIdentity = {
    id: newConnectId(),
    displayName: displayName ?? `${host}-${randomBytes(2).toString("hex")}`,
    host,
    chainId: 97,
    owner: machineOwner(host),
  };
  writeFileSync(path, JSON.stringify(identity, null, 2));
  return identity;
}

export function saveIdentity(identity: ConnectIdentity): void {
  const dir = dataDir(identity.host);
  mkdirSync(dir, { recursive: true });
  writeFileSync(heldPath ?? join(dir, "identity.json"), JSON.stringify(identity, null, 2));
}
