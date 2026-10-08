// OpenCode 2.x plugin adapter.
//
// OpenCode 2.0.16 loads every `.opencode/plugins/*.js` file as a plugin whose
// default export is `{ id, setup }` (or `{ id, effect }`); the 1.x plain
// `export const ... = async ({ client, directory, worktree }) => ...` shape is
// no longer recognized and fails with "Plugin must export a default definition
// with an id and an effect or setup function". The 2.x `setup(context)` is
// handed a rich context instead of the 1.x server input, its event stream uses
// internal event names (for example `session.execution.succeeded` rather than
// `session.idle`), and `context.session.prompt` takes `{ sessionID, text }`
// instead of `client.session.promptAsync({ path, body })`.
//
// A plugin keeps its 1.x hook logic by exporting
// `{ id, server: <1.x factory>, setup: <2.x setup> }`; the 1.x loader calls
// `server`, the 2.x loader calls `setup`. These helpers let the 2.x setup reuse
// the 1.x logic: `openCode2Client` presents the 1.x client shape over the 2.x
// prompt endpoint, `openCode2Root` resolves the plugin's checkout, and the
// event helpers normalize the 2.x event shape onto the 1.x semantics.
//
// Loaded only from OpenCode plugin files; the 1.x plugin loader never imports
// this module because it calls the `server` factory instead.

// The 2.x plugin runs against its project root, which is the git top level of
// the checkout whose `.opencode/plugins` it was loaded from (a task worktree
// resolves to the worktree, not the primary checkout). Falls back to the
// session directory when no project is attached.
export function openCode2Root(context) {
  return context?.location?.project?.directory || context?.location?.directory || "";
}

// A 1.x-shaped client over the 2.x prompt endpoint, so callers keep sending
// `{ path: { id }, body: { parts: [{ type: "text", text }] } }`.
export function openCode2Client(context) {
  return {
    session: {
      promptAsync: async ({ path, body } = {}) => {
        const text = (body?.parts ?? [])
          .filter((part) => part && part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
        return context.session.prompt({ sessionID: path?.id, text });
      },
    },
  };
}

// The session a 2.x event belongs to. 2.x events carry `data.sessionID`;
// `properties.sessionID` is accepted for a build that still uses the 1.x field.
export function openCode2SessionID(event) {
  return event?.data?.sessionID ?? event?.properties?.sessionID ?? "";
}

// A 2.x turn end. The 2.x event stream has no `session.idle`; the agent loop
// reports completion through `session.execution.succeeded` (and the sibling
// failure and interruption events). `session.idle` and an idle `session.status`
// stay recognized for a build that emits them.
export function isOpenCode2TurnEnd(event) {
  const type = event?.type;
  if (type === "session.idle") return true;
  if (type === "session.status") {
    const status = event?.data?.status ?? event?.properties?.status;
    const kind = typeof status === "string" ? status : status?.type;
    return kind === "idle";
  }
  return (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted"
  );
}
