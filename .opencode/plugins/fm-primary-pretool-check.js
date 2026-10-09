import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { openCode2Root } from "./lib/fm-opencode-v2.js";

// PreToolUse seatbelt for OpenCode: the arm mechanism itself lives entirely in
// fm-primary-watch-arm.js (a plugin-owned child process, never a model tool
// call), so the residual risk here is the AGENT shelling `bin/fm-watch-arm.sh`
// wrong through its own bash tool - the anti-pattern bin/fm-arm-pretool-check.sh
// guards against (see that script's header and docs/arm-pretool-check.md).
// tool.execute.before can block by throwing (verified 2026-07-09 against
// OpenCode 1.17.15: throwing here prevents the bash command from running and
// surfaces the thrown message as the failed tool result).

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

// Shared by both harness APIs: run the anti-pattern check and refuse the command
// by throwing, which both harness APIs surface as the failed tool result.
async function checkCommand(root, command) {
  if (!root || typeof command !== "string") return;
  const result = await runProcess(`${root}/bin/fm-arm-pretool-check.sh`, ["--command", command]);
  if (result.code !== 2) return;

  const reason = result.stderr.trim() || "denied by the watcher-arm PreToolUse seatbelt";
  throw new Error(reason);
}

// OpenCode 1.x: the loader calls this factory and wires the returned hooks.
export const FmPrimaryPretoolCheck = async ({ directory, worktree }) => {
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
async function setupPretoolCheck(context) {
  if (typeof context?.tool?.hook !== "function") return;
  const root = openCode2Root(context);
  await context.tool.hook("execute.before", async (input) => {
    if (!root || (input?.tool !== "shell" && input?.tool !== "bash")) return;
    await checkCommand(root, input?.input?.command);
  });
}

export default {
  id: "fm.primary.pretool-check",
  server: FmPrimaryPretoolCheck,
  setup: setupPretoolCheck,
};
