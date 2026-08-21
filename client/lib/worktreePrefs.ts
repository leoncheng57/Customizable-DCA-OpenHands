const STORAGE_KEY = "openhands.newSessionWorktree.v1";

/** Whether local-project sessions start in a fresh git worktree (default: on). */
export function loadNewSessionWorktree(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveNewSessionWorktree(
  enabled: boolean,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    /* private mode etc. — preference just won't stick */
  }
}
