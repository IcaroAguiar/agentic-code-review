#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = join(packageRoot, "skills", "agentic-code-review");

function usage() {
  console.log(`agentic-code-review

Usage:
  agentic-code-review install [--target agents|codex] [--dest <dir>] [--force]
  agentic-code-review collect [collector args...]
  agentic-code-review calibrate [calibration args...]
  agentic-code-review smoke
  agentic-code-review help

Examples:
  npx agentic-code-review install
  npx agentic-code-review collect --base origin/main
  npx agentic-code-review collect --base origin/main --json
  npx agentic-code-review collect --full-repo --json
  npx agentic-code-review collect --root ../api --root ../web
  npx agentic-code-review calibrate --repo . --case pr-101:abc123:def456 --feedback-file reviewer-feedback.json
  npx agentic-code-review smoke
`);
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function defaultSkillDir(target) {
  const home = homeDir();
  if (!home) throw new Error("Cannot resolve home directory. Pass --dest <dir>.");
  if (target === "codex") return join(home, ".codex", "skills");
  return join(home, ".agents", "skills");
}

function parseInstallArgs(args) {
  let target = "agents";
  let dest = "";
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      target = args[index + 1] || target;
      index += 1;
    } else if (arg.startsWith("--target=")) {
      target = arg.split("=").slice(1).join("=");
    } else if (arg === "--dest") {
      dest = args[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--dest=")) {
      dest = arg.split("=").slice(1).join("=");
    } else if (arg === "--force") {
      force = true;
    } else {
      throw new Error(`Unknown install option: ${arg}`);
    }
  }

  if (!["agents", "codex"].includes(target)) {
    throw new Error("--target must be either agents or codex");
  }

  return { target, dest, force };
}

function install(args) {
  const { target, dest, force } = parseInstallArgs(args);
  const baseDir = resolve(dest || defaultSkillDir(target));
  const destination = join(baseDir, "agentic-code-review");

  if (!existsSync(skillSource)) {
    throw new Error(`Skill source not found: ${skillSource}`);
  }

  mkdirSync(baseDir, { recursive: true });
  if (existsSync(destination)) {
    if (!force) {
      throw new Error(`Destination already exists: ${destination}. Re-run with --force to replace it.`);
    }
    rmSync(destination, { recursive: true, force: true });
  }

  cpSync(skillSource, destination, { recursive: true });
  console.log(`Installed agentic-code-review skill to ${destination}`);
  console.log("Restart your agent runtime so it can discover the new skill.");
}

function runNodeScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function main() {
  const [command = "help", ...args] = process.argv.slice(2);

  try {
    if (command === "help" || command === "--help" || command === "-h") {
      usage();
      return;
    }
    if (command === "install") {
      install(args);
      return;
    }
    if (command === "collect") {
      runNodeScript(join(skillSource, "scripts", "collect-review-context.mjs"), args);
      return;
    }
    if (command === "calibrate") {
      runNodeScript(join(skillSource, "scripts", "calibrate-review-history.mjs"), args);
      return;
    }
    if (command === "smoke") {
      runNodeScript(join(skillSource, "scripts", "smoke-review-toolbelt.mjs"), args);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(`agentic-code-review: ${error.message}`);
    process.exit(1);
  }
}

main();
