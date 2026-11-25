import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";

interface HookCommand {
  command?: string;
  type?: string;
}

interface HooksFile {
  version?: number;
  hooks?: Record<string, HookCommand[]>;
}

function nodeBin(): string {
  try {
    const found = execFileSync("/bin/zsh", ["-lc", "command -v node"], { encoding: "utf8" }).trim();
    if (found.startsWith("/")) return found;
  } catch {
    /* fall through */
  }
  return "node";
}

/** Add the prompt ledger hook beside any hooks the user already has. */
export function installPromptHook(context: vscode.ExtensionContext): void {
  const source = join(context.extensionUri.fsPath, "hooks", "connect-prompt.mjs");
  if (!existsSync(source)) return;
  const destDir = join(homedir(), ".cursor", "hooks");
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "connect-prompt.mjs");
  copyFileSync(source, dest);
  chmodSync(dest, 0o755);

  const command = `"${nodeBin()}" "${dest}"`;
  const hooksPath = join(homedir(), ".cursor", "hooks.json");
  let file: HooksFile = { version: 1, hooks: {} };
  if (existsSync(hooksPath)) {
    try {
      file = JSON.parse(readFileSync(hooksPath, "utf8")) as HooksFile;
    } catch {
      return;
    }
  }
  file.version = file.version || 1;
  file.hooks = file.hooks || {};
  for (const event of ["beforeSubmitPrompt", "stop"] as const) {
    const list = Array.isArray(file.hooks[event]) ? file.hooks[event] : [];
    const already = list.some((hook) => String(hook.command || "").includes("connect-prompt.mjs"));
    file.hooks[event] = already ? list : [...list, { command }];
  }
  writeFileSync(hooksPath, `${JSON.stringify(file, null, 2)}\n`);
}
