import { existsSync, readdirSync } from "node:fs";

// Whether a home needs an OpenCode watcher armed. Kept out of the plugin module
// because OpenCode treats every export of a loaded plugin file as a plugin, so
// the predicate is testable here without adding a spurious export there.
//
// A registered process-event source (state/procevent/<id>.source) or a trust-
// bound custom check (state/<id>.check.sh with state/<id>.check-trust, never
// X-mode's x-watch shim) is itself a reason to watch, so a home whose only
// supervision need is one of these must still arm after the last task ends.
// bin/fm-supervision-lib.sh's fm_supervision_status owns the same predicate as
// FM_SUP_NEEDED, and docs/configuration.md states a registered check keeps the
// watcher after teardown.
function registeredSupervisionNeed(paths) {
  try {
    if (readdirSync(`${paths.state}/procevent`).some((name) => name.endsWith(".source"))) {
      return true;
    }
  } catch {
    // No process-event directory is no source.
  }
  try {
    return readdirSync(paths.state).some((name) => {
      if (!name.endsWith(".check.sh")) return false;
      const id = name.slice(0, -".check.sh".length);
      if (id === "x-watch") return false;
      return existsSync(`${paths.state}/${id}.check-trust`);
    });
  } catch {
    return false;
  }
}

export function shouldArm(paths) {
  if (existsSync(`${paths.state}/.afk`)) return false;
  if (existsSync(`${paths.config}/x-mode.env`)) return true;
  if (registeredSupervisionNeed(paths)) return true;
  try {
    return readdirSync(paths.state).some((name) => name.endsWith(".meta"));
  } catch {
    return false;
  }
}
