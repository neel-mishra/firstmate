import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { openCode2Client, openCode2Root, openCode2SessionID } from "./lib/fm-opencode-v2.js";

const handledSessions = new Set();

function runProcess(command, args) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolveResult({ code: 0, stdout: "" }));
    child.on("close", (code) => resolveResult({ code: code ?? 0, stdout }));
  });
}

function resolvePath(anchor) {
  try {
    return realpathSync(anchor);
  } catch {
    return resolve(anchor);
  }
}

async function resolveRoot(anchor) {
  if (!anchor) return "";
  const result = await runProcess("git", ["-C", anchor, "rev-parse", "--show-toplevel"]);
  const root = result.stdout.trim();
  if (result.code === 0 && root) return root;
  return resolvePath(anchor);
}

// Shared by both harness APIs: deliver the wrapper nudge once per new session.
async function deliverNudge(root, client, sessionID) {
  if (!sessionID || handledSessions.has(sessionID) || !root) return;
  handledSessions.add(sessionID);

  const result = await runProcess(`${root}/bin/fm-sessionstart-nudge.sh`, []);
  const nudge = result.code === 0 ? result.stdout.trim() : "";
  if (!nudge) return;

  try {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: nudge }],
      },
    });
  } catch {
  }
}

// OpenCode 1.x: the loader calls this factory and wires the returned hooks.
export const FmPrimarySessionstartNudge = async ({ client, directory, worktree }) => {
  const root = worktree ? resolvePath(worktree) : await resolveRoot(directory);

  return {
    event: async ({ event }) => {
      if (event.type !== "session.created") return;
      const sessionID = event.properties?.info?.id ?? event.properties?.sessionID;
      await deliverNudge(root, client, sessionID);
    },
  };
};

// OpenCode 2.x: the loader calls setup(context); subscribe to session.created.
async function setupSessionstartNudge(context) {
  if (typeof context?.event?.subscribe !== "function") return;
  const root = openCode2Root(context);
  const client = openCode2Client(context);
  void (async () => {
    try {
      for await (const event of context.event.subscribe()) {
        if (event?.type !== "session.created") continue;
        await deliverNudge(root, client, openCode2SessionID(event));
      }
    } catch {
      // OpenCode owns the event stream; a closed stream ends nudge delivery.
    }
  })();
}

export default {
  id: "fm.primary.sessionstart-nudge",
  server: FmPrimarySessionstartNudge,
  setup: setupSessionstartNudge,
};
