import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { GLOBAL_INSTALL_ROOT, LOCK_FILE_NAME } from "./constants.js";
import type { InstallScope } from "./installer.js";

const LOCK_VERSION = 1;

export interface PluginLockEntry {
  source: string;
  pluginVersion?: string;
}

export interface GlobalPluginLockEntry extends PluginLockEntry {
  installedAt: string;
  updatedAt: string;
}

export interface PluginLockFile {
  version: number;
  plugins: Record<string, PluginLockEntry>;
}

export function getLockPath(scope: InstallScope): string {
  return scope === "global"
    ? path.join(GLOBAL_INSTALL_ROOT, LOCK_FILE_NAME)
    : path.join(process.cwd(), LOCK_FILE_NAME);
}

export async function readLock(scope: InstallScope): Promise<PluginLockFile> {
  const lockPath = getLockPath(scope);
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as PluginLockFile;
    if (typeof parsed.version !== "number" || typeof parsed.plugins !== "object" || parsed.plugins === null) {
      return emptyLock();
    }
    return parsed;
  } catch {
    return emptyLock();
  }
}

export async function writeLock(lock: PluginLockFile, scope: InstallScope): Promise<void> {
  const lockPath = getLockPath(scope);
  await mkdir(path.dirname(lockPath), { recursive: true });

  const sortedPlugins: Record<string, PluginLockEntry> = {};
  for (const key of Object.keys(lock.plugins).sort()) {
    sortedPlugins[key] = lock.plugins[key]!;
  }

  const sorted: PluginLockFile = { version: lock.version, plugins: sortedPlugins };
  await writeFile(lockPath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

export async function addPluginsToLock(
  entries: Array<{ name: string; source: string; pluginVersion?: string }>,
  scope: InstallScope,
): Promise<void> {
  const lock = await readLock(scope);
  const now = new Date().toISOString();

  for (const { name, source, pluginVersion } of entries) {
    const base: PluginLockEntry = { source };
    if (pluginVersion !== undefined) base.pluginVersion = pluginVersion;

    if (scope === "global") {
      const existing = lock.plugins[name] as GlobalPluginLockEntry | undefined;
      (lock.plugins[name] as GlobalPluginLockEntry) = {
        ...base,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      };
    } else {
      lock.plugins[name] = base;
    }
  }

  await writeLock(lock, scope);
}

function emptyLock(): PluginLockFile {
  return { version: LOCK_VERSION, plugins: {} };
}
