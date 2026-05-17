import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  COPILOT_INSTRUCTIONS_FILE,
  DIRECTORY_TARGETS,
  GLOBAL_INSTALL_ROOT,
  MARKETPLACE_MANIFEST,
  PROJECT_INSTALL_ROOT,
  type ArtifactKind,
  type DirectoryArtifactKind,
} from "./constants.js";

const execFileAsync = promisify(execFile);

export type InstallScope = "project" | "global";

export interface CliFlags {
  pluginName?: string;
  installAll: boolean;
  yes: boolean;
  scope: InstallScope;
  allowOverwrite?: boolean;
}

interface MarketplacePlugin {
  name: string;
  source: string | Record<string, unknown>;
  description?: string;
  version?: string;
}

interface MarketplaceManifest {
  name?: string;
  plugins: MarketplacePlugin[];
}

interface ResolvedSource {
  marketplaceRoot: string;
  requestedPath: string;
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
  const localPath = await tryResolveLocalPath(source);
  if (localPath) {
    return {
      cleanup: undefined,
      marketplaceRoot: await findMarketplaceRoot(localPath),
      requestedPath: localPath,
    };
  }

  const parsedGitHubSource = parseGitHubSource(source);
  if (!parsedGitHubSource) {
    throw new Error(
      `Unsupported source "${source}". Use a local path, owner/repo shorthand, a GitHub URL, or a git@github.com URL.`,
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

  const requestedPath = path.resolve(checkoutRoot, parsedGitHubSource.subpath ?? ".");

  try {
    await access(requestedPath);
  } catch {
    await rm(tempRoot, { force: true, recursive: true });
    throw new Error(
      `Resolved source path "${parsedGitHubSource.subpath ?? "."}" does not exist in ${parsedGitHubSource.cloneUrl}.`,
    );
  }

  return {
    cleanup: async () => rm(tempRoot, { force: true, recursive: true }),
    marketplaceRoot: await findMarketplaceRoot(requestedPath),
    requestedPath,
  };
}

export async function installFromMarketplace(
  source: string,
  flags: CliFlags,
  selectPlugins: (plugins: PluginCandidate[]) => Promise<PluginCandidate[]>,
): Promise<AddCommandResult> {
  const resolvedSource = await resolveSource(source);

  try {
    const manifest = await readMarketplaceManifest(resolvedSource.marketplaceRoot);
    const warnings: string[] = [];
    const skippedPlugins: string[] = [];
    const localCandidates: PluginCandidate[] = [];

    for (const plugin of manifest.plugins) {
      if (typeof plugin.source !== "string") {
        skippedPlugins.push(plugin.name);
        warnings.push(`Skipped plugin "${plugin.name}": external marketplace sources are deferred to MVP2.`);
        continue;
      }

      const pluginRoot = path.resolve(resolvedSource.marketplaceRoot, plugin.source);
      await assertDirectory(pluginRoot, `Plugin "${plugin.name}" points to missing directory "${plugin.source}".`);
      localCandidates.push({ plugin, pluginRoot });
    }

    const scopedCandidates = narrowCandidatesByRequestedPath(localCandidates, resolvedSource.requestedPath);
    const candidatePool = scopedCandidates.length > 0 ? scopedCandidates : localCandidates;

    if (candidatePool.length === 0) {
      throw new Error("No installable plugins were found in the marketplace.");
    }

    const selectedCandidates = await selectPlugins(candidatePool);
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

    await ensureNoConflicts(installablePlans, flags.allowOverwrite ?? false);
    await copyInstallPlans(installablePlans);

    return {
      installedPlugins: installablePlans,
      skippedPlugins,
      sourceRoot: resolvedSource.marketplaceRoot,
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
  const manifestPath = path.join(marketplaceRoot, MARKETPLACE_MANIFEST);
  let raw: string;

  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new Error(`MVP1 requires a marketplace manifest at "${manifestPath}".`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw wrapExecError(`Failed to parse marketplace manifest at "${manifestPath}"`, error);
  }

  if (!isMarketplaceManifest(parsed)) {
    throw new Error(`Marketplace manifest at "${manifestPath}" is missing a valid "plugins" array.`);
  }

  return parsed;
}

async function findMarketplaceRoot(startingPath: string): Promise<string> {
  let currentPath = path.resolve(startingPath);
  const stats = await readdirOrNull(currentPath);

  if (stats === null) {
    currentPath = path.dirname(currentPath);
  }

  while (true) {
    const candidate = path.join(currentPath, MARKETPLACE_MANIFEST);
    if (await pathExists(candidate)) {
      return currentPath;
    }

    const parent = path.dirname(currentPath);
    if (parent === currentPath) {
      break;
    }

    currentPath = parent;
  }

  throw new Error(`MVP1 requires a marketplace manifest. None was found from "${startingPath}" upward.`);
}

function narrowCandidatesByRequestedPath(candidates: PluginCandidate[], requestedPath: string): PluginCandidate[] {
  const resolvedRequestedPath = path.resolve(requestedPath);

  return candidates.filter((candidate) => {
    const pluginRoot = path.resolve(candidate.pluginRoot);
    return isSamePath(pluginRoot, resolvedRequestedPath) || isDescendantOf(resolvedRequestedPath, pluginRoot);
  });
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

async function ensureNoConflicts(plans: PluginInstallPlan[], allowOverwrite = false): Promise<void> {
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

      if (!allowOverwrite && (await pathExists(entry.targetPath))) {
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

async function tryResolveLocalPath(source: string): Promise<string | null> {
  const expandedSource = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
  const shouldTreatAsPath =
    expandedSource.startsWith(".") || expandedSource.startsWith("/") || expandedSource.startsWith("~");

  if (!shouldTreatAsPath) {
    const candidate = path.resolve(expandedSource);
    if (!(await pathExists(candidate))) {
      return null;
    }

    return candidate;
  }

  const resolved = path.resolve(expandedSource);
  return (await pathExists(resolved)) ? resolved : null;
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

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isDescendantOf(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function createTempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "copilot-plugin-"));
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

export { readMarketplaceManifest as readMarketplaceManifestPublic };
