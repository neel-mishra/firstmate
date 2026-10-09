import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { openCode2Root } from "./lib/fm-opencode-v2.js";

// PreToolUse seatbelt for OpenCode: block a stray persistent top-level `cd` in
// the primary firstmate checkout before the agent's bash tool relocates the
// shell out of the home (see bin/fm-cd-pretool-check.sh and docs/cd-guard.md).
// This mirrors fm-primary-pretool-check.js, calling the cd-guard owner instead
// of the watcher-arm one. tool.execute.before can block by throwing (verified
// 2026-07-09 against OpenCode 1.17.15 for the watcher-arm plugin; the same
// mechanism carries this guard). The owner script is itself inert outside the
// real primary checkout, so a crewmate/scout worktree is never affected.

function runProcess(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolvePromise({ code: 0, stdout: "", stderr: "" }));
    child.on("close", (code) => resolvePromise({ code: code ?? 0, stdout, stderr }));
  });
}

async function resolveRoot(anchor) {
  if (!anchor) return "";
  const result = await runProcess("git", ["-C", anchor, "rev-parse", "--show-toplevel"]);
  const root = result.stdout.trim();
  if (result.code === 0 && root) return root;
  try {
    return realpathSync(anchor);
  } catch {
    return resolve(anchor);
  }
}

// Shared by both harness APIs: run the cd guard and refuse the command by
// throwing, which both harness APIs surface as the failed tool result.
async function checkCommand(root, command) {
  if (!root || typeof command !== "string") return;
  const result = await runProcess(`${root}/bin/fm-cd-pretool-check.sh`, ["--command", command]);
  if (result.code !== 2) return;

  const reason = result.stderr.trim() || "denied by the cd-guard PreToolUse seatbelt";
  throw new Error(reason);
}

// OpenCode 1.x: the loader calls this factory and wires the returned hooks.
export const FmPrimaryCdCheck = async ({ directory, worktree }) => {
  const root = worktree ? (() => {
    try {
      return realpathSync(worktree);
    } catch {
      return resolve(worktree);
    }
  })() : await resolveRoot(directory);

  return {
    "tool.execute.before": async (input, output) => {
      if (!root || input?.tool !== "bash") return;
      await checkCommand(root, output?.args?.command);
    },
  };
};

// OpenCode 2.x: the loader calls setup(context); register the same seatbelt via
// context.tool.hook("execute.before"). The 2.x shell tool is named "shell".
async function setupCdCheck(context) {
  if (typeof context?.tool?.hook !== "function") return;
  const root = openCode2Root(context);
  await context.tool.hook("execute.before", async (input) => {
    if (!root || (input?.tool !== "shell" && input?.tool !== "bash")) return;
    await checkCommand(root, input?.input?.command);
  });
}

export default {
  id: "fm.primary.cd-check",
  server: FmPrimaryCdCheck,
  setup: setupCdCheck,
};
