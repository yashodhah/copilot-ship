import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  COPILOT_INSTRUCTIONS_FILE,
  DIRECTORY_TARGETS,
  GLOBAL_INSTALL_ROOT,
  MARKETPLACE_MANIFEST_CANDIDATES,
  PLUGIN_JSON_CANDIDATES,
  PROJECT_INSTALL_ROOT,
  type ArtifactKind,
  type DirectoryArtifactKind,
} from "./constants.js";

const execFileAsync = promisify(execFile);

export type InstallScope = "project" | "global";
export type SourceKind = "marketplace" | "plugin";

export interface CliFlags {
  pluginName?: string;
  installAll: boolean;
  yes: boolean;
  scope: InstallScope;
}

interface MarketplacePlugin {
  name: string;
  source: string | Record<string, unknown>;
  description?: string;
}

interface MarketplaceManifest {
  name?: string;
  plugins: MarketplacePlugin[];
}

interface ResolvedSource {
  kind: SourceKind;
  root: string;
  cleanup: (() => Promise<void>) | undefined;
}

interface PluginCandidate {
  plugin: MarketplacePlugin;
  pluginRoot: string;
}

interface InstallEntry {
  kind: ArtifactKind;
  sourcePath: string;
  targetPath: string;
  targetRelativePath: string;
}

interface PluginInstallPlan {
  plugin: MarketplacePlugin;
  pluginRoot: string;
  entries: InstallEntry[];
}

export interface AddCommandResult {
  installedPlugins: PluginInstallPlan[];
  skippedPlugins: string[];
  warnings: string[];
  targetRoot: string;
  sourceRoot: string;
}

export interface ListedArtifacts {
  targetRoot: string;
  groups: Array<{
    kind: ArtifactKind;
    entries: string[];
  }>;
}

export async function resolveSource(source: string): Promise<ResolvedSource> {
  const parsedGitHubSource = parseGitHubSource(source);
  if (!parsedGitHubSource) {
    throw new Error(
      `Unsupported source "${source}". Use owner/repo shorthand or a GitHub URL.`,
    );
  }

  const tempRoot = await createTempDirectory();
  const checkoutRoot = path.join(tempRoot, "source");
  const cloneArgs = ["clone", "--quiet", "--depth", "1"];

  if (parsedGitHubSource.branch) {
    cloneArgs.push("--branch", parsedGitHubSource.branch, "--single-branch");
  }

  cloneArgs.push(parsedGitHubSource.cloneUrl, checkoutRoot);

  try {
    await execFileAsync("git", cloneArgs);
  } catch (error) {
    await rm(tempRoot, { force: true, recursive: true });
    throw wrapExecError(`Failed to clone ${parsedGitHubSource.cloneUrl}`, error);
  }

  const cleanup = async () => rm(tempRoot, { force: true, recursive: true });

  if (parsedGitHubSource.subpath) {
    const pluginRoot = path.resolve(checkoutRoot, parsedGitHubSource.subpath);

    try {
      await access(pluginRoot);
    } catch {
      await cleanup();
      throw new Error(
        `Path "${parsedGitHubSource.subpath}" does not exist in ${parsedGitHubSource.cloneUrl}.`,
      );
    }

    const pluginJsonPath = await findPluginJsonAtRoot(pluginRoot);
    if (!pluginJsonPath) {
      await cleanup();
      throw new Error(
        `No plugin.json found at "${parsedGitHubSource.subpath}" in ${parsedGitHubSource.cloneUrl}. ` +
          `Expected one of: ${PLUGIN_JSON_CANDIDATES.join(", ")}.`,
      );
    }

    return { kind: "plugin", root: pluginRoot, cleanup };
  }

  return { kind: "marketplace", root: checkoutRoot, cleanup };
}

export async function installFromMarketplace(
  source: string,
  flags: CliFlags,
  selectPlugins: (plugins: PluginCandidate[], kind: SourceKind) => Promise<PluginCandidate[]>,
): Promise<AddCommandResult> {
  const resolvedSource = await resolveSource(source);

  try {
    const manifest =
      resolvedSource.kind === "marketplace"
        ? await readMarketplaceManifest(resolvedSource.root)
        : await readPluginJson(resolvedSource.root);

    const warnings: string[] = [];
    const skippedPlugins: string[] = [];
    const candidates: PluginCandidate[] = [];

    for (const plugin of manifest.plugins) {
      if (typeof plugin.source !== "string") {
        skippedPlugins.push(plugin.name);
        warnings.push(`Skipped plugin "${plugin.name}": external marketplace sources are deferred to MVP2.`);
        continue;
      }

      const pluginRoot = path.resolve(resolvedSource.root, plugin.source);
      await assertDirectory(pluginRoot, `Plugin "${plugin.name}" points to missing directory "${plugin.source}".`);
      candidates.push({ plugin, pluginRoot });
    }

    if (candidates.length === 0) {
      throw new Error("No installable plugins were found.");
    }

    const selectedCandidates = await selectPlugins(candidates, resolvedSource.kind);
    if (selectedCandidates.length === 0) {
      throw new Error("No plugins were selected.");
    }

    const targetRoot = getInstallRoot(flags.scope);
    const installPlans = await Promise.all(
      selectedCandidates.map(async (candidate) => ({
        entries: await discoverArtifacts(candidate.pluginRoot, targetRoot),
        plugin: candidate.plugin,
        pluginRoot: candidate.pluginRoot,
      })),
    );

    const installablePlans = installPlans.filter((plan) => {
      if (plan.entries.length === 0) {
        warnings.push(`Plugin "${plan.plugin.name}" has no supported Copilot artifacts.`);
        return false;
      }

      return true;
    });

    if (installablePlans.length === 0) {
      throw new Error("Nothing to install: the selected plugins do not contain supported Copilot artifacts.");
    }

    await ensureNoConflicts(installablePlans);
    await copyInstallPlans(installablePlans);

    return {
      installedPlugins: installablePlans,
      skippedPlugins,
      sourceRoot: resolvedSource.root,
      targetRoot,
      warnings,
    };
  } finally {
    await resolvedSource.cleanup?.();
  }
}

export async function listInstalledArtifacts(scope: InstallScope): Promise<ListedArtifacts> {
  const targetRoot = getInstallRoot(scope);
  const groups: ListedArtifacts["groups"] = [];

  const instructionsPath = path.join(targetRoot, COPILOT_INSTRUCTIONS_FILE);
  if (await pathExists(instructionsPath)) {
    groups.push({
      entries: [COPILOT_INSTRUCTIONS_FILE],
      kind: "copilot-instructions",
    });
  }

  for (const kind of Object.keys(DIRECTORY_TARGETS) as DirectoryArtifactKind[]) {
    const root = path.join(targetRoot, DIRECTORY_TARGETS[kind]);
    const entries = await collectRelativeFiles(root);

    if (entries.length > 0) {
      groups.push({ entries, kind });
    }
  }

  return {
    groups,
    targetRoot,
  };
}

function getInstallRoot(scope: InstallScope): string {
  return scope === "global" ? GLOBAL_INSTALL_ROOT : path.resolve(process.cwd(), PROJECT_INSTALL_ROOT);
}

async function readMarketplaceManifest(marketplaceRoot: string): Promise<MarketplaceManifest> {
  for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
    const manifestPath = path.join(marketplaceRoot, candidate);
    let raw: string;

    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!isMarketplaceManifest(parsed)) {
      continue;
    }

    return parsed;
  }

  throw new Error(
    `No marketplace manifest found. Expected one of: ${MARKETPLACE_MANIFEST_CANDIDATES.join(", ")} at the repository root.`,
  );
}

async function findPluginJsonAtRoot(pluginRoot: string): Promise<string | null> {
  for (const candidate of PLUGIN_JSON_CANDIDATES) {
    const fullPath = path.join(pluginRoot, candidate);
    if (await pathExists(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

async function readPluginJson(pluginRoot: string): Promise<MarketplaceManifest> {
  const pluginJsonPath = await findPluginJsonAtRoot(pluginRoot);
  if (!pluginJsonPath) {
    throw new Error(
      `No plugin.json found at the specified path. Expected one of: ${PLUGIN_JSON_CANDIDATES.join(", ")}.`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(pluginJsonPath, "utf8");
  } catch {
    throw new Error(`Failed to read plugin.json at "${pluginJsonPath}".`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw wrapExecError(`Failed to parse plugin.json at "${pluginJsonPath}"`, error);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`plugin.json at "${pluginJsonPath}" must be a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : path.basename(pluginRoot);
  const plugin: MarketplacePlugin = { name, source: "." };

  if (typeof record.description === "string") {
    plugin.description = record.description;
  }

  return { plugins: [plugin] };
}

async function discoverArtifacts(pluginRoot: string, targetRoot: string): Promise<InstallEntry[]> {
  const entries: InstallEntry[] = [];

  const repoInstructions = path.join(pluginRoot, COPILOT_INSTRUCTIONS_FILE);
  if (await pathExists(repoInstructions)) {
    entries.push({
      kind: "copilot-instructions",
      sourcePath: repoInstructions,
      targetPath: path.join(targetRoot, COPILOT_INSTRUCTIONS_FILE),
      targetRelativePath: COPILOT_INSTRUCTIONS_FILE,
    });
  }

  for (const kind of Object.keys(DIRECTORY_TARGETS) as DirectoryArtifactKind[]) {
    const sourceRoot = path.join(pluginRoot, DIRECTORY_TARGETS[kind]);
    if (!(await pathExists(sourceRoot))) {
      continue;
    }

    const files = await walkFiles(sourceRoot);
    for (const file of files) {
      const relativePath = path.relative(sourceRoot, file);
      entries.push({
        kind,
        sourcePath: file,
        targetPath: path.join(targetRoot, DIRECTORY_TARGETS[kind], relativePath),
        targetRelativePath: path.join(DIRECTORY_TARGETS[kind], relativePath),
      });
    }
  }

  return entries.sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath));
}

async function ensureNoConflicts(plans: PluginInstallPlan[]): Promise<void> {
  const seenTargets = new Map<string, string>();
  const fileConflicts: string[] = [];

  for (const plan of plans) {
    for (const entry of plan.entries) {
      const existingSource = seenTargets.get(entry.targetPath);
      if (existingSource) {
        throw new Error(
          `Install conflict: "${entry.targetRelativePath}" would be written by both "${existingSource}" and "${plan.plugin.name}".`,
        );
      }

      seenTargets.set(entry.targetPath, plan.plugin.name);

      if (await pathExists(entry.targetPath)) {
        fileConflicts.push(entry.targetPath);
      }
    }
  }

  if (fileConflicts.length > 0) {
    throw new Error(
      `Install conflict: target file already exists:\n${fileConflicts.map((conflict) => `- ${conflict}`).join("\n")}`,
    );
  }
}

async function copyInstallPlans(plans: PluginInstallPlan[]): Promise<void> {
  for (const plan of plans) {
    for (const entry of plan.entries) {
      await mkdir(path.dirname(entry.targetPath), { recursive: true });
      await copyFile(entry.sourcePath, entry.targetPath);
    }
  }
}

async function collectRelativeFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const files = await walkFiles(root);
  return files
    .map((file) => path.relative(root, file))
    .sort((left, right) => left.localeCompare(right));
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function assertDirectory(directoryPath: string, errorMessage: string): Promise<void> {
  const children = await readdirOrNull(directoryPath);
  if (children === null) {
    throw new Error(errorMessage);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readdirOrNull(targetPath: string): Promise<string[] | null> {
  try {
    return await readdir(targetPath);
  } catch {
    return null;
  }
}

function parseGitHubSource(source: string):
  | {
      branch?: string;
      cloneUrl: string;
      subpath?: string;
    }
  | null {
  const shorthandMatch = source.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthandMatch) {
    const owner = shorthandMatch[1];
    const repo = shorthandMatch[2];
    if (!owner || !repo) {
      return null;
    }

    return { cloneUrl: `https://github.com/${owner}/${stripGitSuffix(repo)}.git` };
  }

  const sshMatch = source.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { cloneUrl: source };
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }

  if (url.hostname !== "github.com") {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const owner = segments[0];
  const repoSegment = segments[1];
  if (!owner || !repoSegment) {
    return null;
  }

  const repo = stripGitSuffix(repoSegment);
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  if (segments[2] === "tree" && segments[3]) {
    return {
      branch: segments[3],
      cloneUrl,
      subpath: segments.slice(4).join("/"),
    };
  }

  return { cloneUrl };
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

function isMarketplaceManifest(value: unknown): value is MarketplaceManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return Array.isArray(record.plugins) && record.plugins.every(isMarketplacePlugin);
}

function isMarketplacePlugin(value: unknown): value is MarketplacePlugin {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && "source" in record;
}

async function createTempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "copilot-ship-"));
}

function wrapExecError(prefix: string, error: unknown): Error {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr.length > 0) {
      return new Error(`${prefix}: ${stderr}`);
    }
  }

  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`);
  }

  return new Error(prefix);
}
