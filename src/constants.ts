import os from "node:os";
import path from "node:path";

export const MARKETPLACE_MANIFEST = path.join(".claude-plugin", "marketplace.json");
export const PROJECT_INSTALL_ROOT = ".github";
export const GLOBAL_INSTALL_ROOT = path.join(os.homedir(), ".copilot");

// VS Code plugin.json discovery order — checked at the plugin root (no directory walk-up).
// Source: https://code.visualstudio.com/docs/copilot/customization/agent-plugins
export const PLUGIN_JSON_CANDIDATES = [
  path.join(".plugin", "plugin.json"),
  "plugin.json",
  path.join(".github", "plugin", "plugin.json"),
  path.join(".claude-plugin", "plugin.json"),
] as const;

export const DIRECTORY_TARGETS = {
  agents: "agents",
  hooks: "hooks",
  instructions: "instructions",
  prompts: "prompts",
  skills: "skills",
} as const;

export type DirectoryArtifactKind = keyof typeof DIRECTORY_TARGETS;
export type ArtifactKind = DirectoryArtifactKind | "copilot-instructions";

export const COPILOT_INSTRUCTIONS_FILE = "copilot-instructions.md";
