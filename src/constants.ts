import os from "node:os";
import path from "node:path";

export const MARKETPLACE_MANIFEST = path.join(".claude-plugin", "marketplace.json");
export const PROJECT_INSTALL_ROOT = ".github";
export const GLOBAL_INSTALL_ROOT = path.join(os.homedir(), ".copilot");

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
