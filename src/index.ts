#!/usr/bin/env node

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  select,
  spinner,
} from "@clack/prompts";

import {
  type AddCommandResult,
  type CliFlags,
  type InstallScope,
  installFromMarketplace,
  listInstalledArtifacts,
} from "./installer.js";

interface ParsedArgs {
  command: "add" | "list" | "help";
  flags: CliFlags;
  source?: string;
}

async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv.slice(2));

  if (parsedArgs.command === "help") {
    printUsage();
    return;
  }

  intro("copilot-plugin");

  try {
    if (parsedArgs.command === "add") {
      await runAdd(parsedArgs);
    } else {
      await runList(parsedArgs.flags.scope);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(message);
    process.exitCode = 1;
  } finally {
    outro("Done.");
  }
}

async function runAdd(parsedArgs: ParsedArgs): Promise<void> {
  if (!parsedArgs.source) {
    throw new Error("The add command requires a source.");
  }

  if (!parsedArgs.flags.yes && process.stdin.isTTY && process.stdout.isTTY && parsedArgs.flags.scope !== "global") {
    const scopeChoice = await select({
      message: "Installation scope",
      options: [
        { label: "Project", hint: "Install into .github/ (committed with your repo)", value: "project" as const },
        { label: "Global", hint: "Install into ~/.copilot/ (available across all projects)", value: "global" as const },
      ],
    });

    if (isCancel(scopeChoice)) {
      cancel("Installation cancelled.");
      process.exit(0);
    }

    parsedArgs.flags.scope = scopeChoice;
  }

  const activity = spinner();
  activity.start("Resolving source and preparing install plan");

  let result: AddCommandResult;
  try {
    result = await installFromMarketplace(parsedArgs.source, parsedArgs.flags, async (plugins) => {
      activity.stop("Marketplace loaded");

      let selected = plugins;

      if (parsedArgs.flags.pluginName) {
        const plugin = plugins.find((candidate) => candidate.plugin.name === parsedArgs.flags.pluginName);
        if (!plugin) {
          throw new Error(`Plugin "${parsedArgs.flags.pluginName}" was not found in the selected marketplace scope.`);
        }

        selected = [plugin];
      } else if (!parsedArgs.flags.installAll && plugins.length > 1) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error("Interactive plugin selection requires a TTY. Use --plugin or --all instead.");
        }

        const selection = await multiselect({
          message: "Select plugins to install",
          options: plugins.map((candidate) => ({
            ...(candidate.plugin.description ? { hint: candidate.plugin.description } : {}),
            label: candidate.plugin.name,
            value: candidate.plugin.name,
          })),
          required: true,
        });

        if (isCancel(selection)) {
          cancel("Installation cancelled.");
          process.exit(0);
        }

        const selectedNames = new Set(Array.isArray(selection) ? selection : []);
        selected = plugins.filter((candidate) => selectedNames.has(candidate.plugin.name));
      }

      if (!parsedArgs.flags.yes) {
        const accepted = await confirm({
          message: `Install ${selected.length} plugin(s) into ${resultTargetDescription(parsedArgs.flags.scope)}?`,
        });

        if (isCancel(accepted) || !accepted) {
          cancel("Installation cancelled.");
          process.exit(0);
        }
      }

      activity.start("Installing selected plugins");
      return selected;
    });
  } catch (error) {
    activity.error("Install failed");
    throw error;
  }

  activity.stop(`Installed ${result.installedPlugins.length} plugin(s) into ${result.targetRoot}`);

  for (const warning of result.warnings) {
    log.warn(warning);
  }

  for (const plan of result.installedPlugins) {
    log.success(`${plan.plugin.name}`);
    for (const entry of plan.entries) {
      log.step(`  ${entry.targetRelativePath}`);
    }
  }
}

async function runList(scope: InstallScope): Promise<void> {
  const result = await listInstalledArtifacts(scope);
  if (result.groups.length === 0) {
    log.info(`No Copilot artifacts installed in ${result.targetRoot}`);
    return;
  }

  log.info(`Installed artifacts in ${result.targetRoot}`);
  for (const group of result.groups) {
    log.step(group.kind);
    for (const entry of group.entries) {
      log.step(`  ${entry}`);
    }
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: CliFlags = {
    installAll: false,
    scope: "project",
    yes: false,
  };

  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    switch (argument) {
      case "add":
      case "list":
      case "help":
        positionals.push(argument);
        break;
      case "-g":
      case "--global":
        flags.scope = "global";
        break;
      case "-y":
      case "--yes":
        flags.yes = true;
        break;
      case "--all":
        flags.installAll = true;
        break;
      case "--plugin": {
        const nextValue = argv[index + 1];
        if (!nextValue) {
          throw new Error("Expected a value after --plugin.");
        }

        flags.pluginName = nextValue;
        index += 1;
        break;
      }
      case "-h":
      case "--help":
        return { command: "help", flags };
      default:
        positionals.push(argument);
        break;
    }
  }

  const command = positionals[0];
  if (!command) {
    return { command: "help", flags };
  }

  if (command !== "add" && command !== "list" && command !== "help") {
    throw new Error(`Unknown command "${command}".`);
  }

  if (command === "list") {
    return { command, flags };
  }

  if (command === "help") {
    return { command, flags };
  }

  const source = positionals[1];
  if (!source) {
    throw new Error("Usage: copilot-plugin add <source> [--plugin <name> | --all] [-g] [-y]");
  }

  return {
    command,
    flags,
    source,
  };
}

function printUsage(): void {
  console.log(`copilot-plugin

Usage:
  copilot-plugin add <source> [--plugin <name> | --all] [-g] [-y]
  copilot-plugin list [-g]

Sources:
  owner/repo
  https://github.com/owner/repo
  https://github.com/owner/repo/tree/main/plugins/my-plugin
  git@github.com:owner/repo.git
  ./local-path
`);
}

function resultTargetDescription(scope: InstallScope): string {
  return scope === "global" ? "~/.copilot" : ".github";
}

void main();
