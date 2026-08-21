// Workspace-mode classification for conversations (issue #31, phase 1).
//
// Every conversation runs in exactly one of two places today, and the UI must
// say which, because the risks differ:
//   - a LOCAL project folder (OPENHANDS_PROJECTS_DIR bind mount): the agent
//     edits the user's ORIGINAL files, shared with their editor and any other
//     conversation pointed at the same folder — collision risk;
//   - an ISOLATED per-conversation sessions/<uuid> dir: nothing else touches
//     it, but it is a throwaway clone rather than the user's checkout.
// The paths mirror LOCAL_ROOT / SESSIONS_ROOT in server/openhands/setup.ts —
// both are fixed container-side mount points, not deployment-specific values.

export const LOCAL_WORKSPACE_ROOT = "/home/openhands/workspace/local";
export const SESSIONS_WORKSPACE_ROOT = "/home/openhands/workspace/sessions";

export type WorkspaceMode =
  /** Shared original project folder; `folder` is relative to the projects root. */
  | { kind: "local"; folder: string }
  /** Isolated per-conversation workspace under sessions/. */
  | { kind: "session" }
  /** Working dir missing or outside both roots (legacy layouts). */
  | { kind: "unknown" };

export function workspaceMode(workingDir: string | null | undefined): WorkspaceMode {
  if (typeof workingDir !== "string" || !workingDir) return { kind: "unknown" };
  if (workingDir === LOCAL_WORKSPACE_ROOT) return { kind: "local", folder: "" };
  if (workingDir.startsWith(`${LOCAL_WORKSPACE_ROOT}/`)) {
    return { kind: "local", folder: workingDir.slice(LOCAL_WORKSPACE_ROOT.length + 1) };
  }
  if (
    workingDir === SESSIONS_WORKSPACE_ROOT ||
    workingDir.startsWith(`${SESSIONS_WORKSPACE_ROOT}/`)
  ) {
    return { kind: "session" };
  }
  return { kind: "unknown" };
}

/** The statuses under which a conversation may still mutate its workspace. */
const ACTIVE_STATUSES = new Set(["running", "waiting_for_confirmation"]);

export interface ActiveFolderUse {
  id: string;
  title: string | null;
}

/**
 * Map of local-folder path (relative to the projects root) → active
 * conversations currently working in it. Drives the "another agent is already
 * in this folder" warning in the create flow: two agents on one working tree
 * clobber each other's edits and branch state.
 */
export function activeLocalFolderUses(
  items: Array<{
    id: string;
    title?: string | null;
    execution_status: string;
    workspace?: { working_dir?: string | null } | null;
  }>,
): Map<string, ActiveFolderUse[]> {
  const map = new Map<string, ActiveFolderUse[]>();
  for (const item of items) {
    if (!ACTIVE_STATUSES.has(item.execution_status)) continue;
    const mode = workspaceMode(item.workspace?.working_dir);
    if (mode.kind !== "local" || !mode.folder) continue;
    const uses = map.get(mode.folder) ?? [];
    uses.push({ id: item.id, title: item.title ?? null });
    map.set(mode.folder, uses);
  }
  return map;
}
