import { type CliFlags, installFromMarketplace, readMarketplaceManifestPublic, resolveSource } from "./installer.js";
import { type PluginLockEntry, addPluginsToLock, readLock } from "./lock.js";

export interface PluginUpdateStatus {
  name: string;
  currentVersion: string;
  latestVersion: string;
}

export interface UpdatePlanResult {
  toUpdate: PluginUpdateStatus[];
  skipped: Array<{ name: string; source: string }>;
}

export async function buildUpdatePlan(
  scope: CliFlags["scope"],
): Promise<{ plan: UpdatePlanResult; entries: Record<string, PluginLockEntry> }> {
  const lock = await readLock(scope);
  const entries = lock.plugins;
  const toUpdate: PluginUpdateStatus[] = [];
  const skipped: Array<{ name: string; source: string }> = [];

  const sourceGroups = new Map<string, Array<{ name: string; entry: PluginLockEntry }>>();
  for (const [name, entry] of Object.entries(entries)) {
    const group = sourceGroups.get(entry.source) ?? [];
    group.push({ name, entry });
    sourceGroups.set(entry.source, group);
  }

  for (const [source, plugins] of sourceGroups) {
    let latestVersions: Map<string, string | undefined>;

    try {
      latestVersions = await fetchVersionsFromSource(source);
    } catch {
      for (const { name } of plugins) {
        skipped.push({ name, source });
      }
      continue;
    }

    for (const { name, entry } of plugins) {
      if (entry.pluginVersion === undefined) {
        skipped.push({ name, source });
        continue;
      }

      const latestVersion = latestVersions.get(name);
      if (latestVersion !== undefined && latestVersion !== entry.pluginVersion) {
        toUpdate.push({ name, currentVersion: entry.pluginVersion, latestVersion });
      }
    }
  }

  return { plan: { toUpdate, skipped }, entries };
}

export async function applyUpdate(
  pluginName: string,
  source: string,
  flags: CliFlags,
): Promise<void> {
  const updateFlags: CliFlags = {
    ...flags,
    pluginName,
    installAll: false,
    yes: true,
    allowOverwrite: true,
  };

  const result = await installFromMarketplace(source, updateFlags, async (candidates) =>
    candidates.filter((c) => c.plugin.name === pluginName),
  );

  await addPluginsToLock(
    result.installedPlugins.map((plan) => {
      const entry: { name: string; source: string; pluginVersion?: string } = {
        name: plan.plugin.name,
        source,
      };
      if (plan.plugin.version !== undefined) {
        entry.pluginVersion = plan.plugin.version;
      }
      return entry;
    }),
    flags.scope,
  );
}

async function fetchVersionsFromSource(source: string): Promise<Map<string, string | undefined>> {
  const resolved = await resolveSource(source);
  try {
    const manifest = await readMarketplaceManifestPublic(resolved.marketplaceRoot);
    const map = new Map<string, string | undefined>();
    for (const plugin of manifest.plugins) {
      if (typeof plugin.source === "string") {
        map.set(plugin.name, plugin.version);
      }
    }
    return map;
  } finally {
    await resolved.cleanup?.();
  }
}
