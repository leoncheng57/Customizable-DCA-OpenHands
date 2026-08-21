// client/mock/state.ts
//
// A scratchpad for handler groups that need a POST to be visible to the next
// GET — creating a conversation, toggling a skill, cancelling a run. It is a
// keyed `Map` with typed accessors and nothing else: the domain shapes live in
// the group that owns them, never here, so the four groups can evolve their
// state independently.
//
// Lifetime is the browser tab. A reload restarts the demo, which is the
// behaviour a visitor expects from a sandbox.
//
// Namespace your keys with the group name to stay out of each other's way:
//
//   const runs = demoState.ensure("manager:runs", () => new Map<string, RunRecord>());

export interface DemoStore {
  /** Stored value, or `undefined` when the key was never written. */
  get<T>(key: string): T | undefined;
  /** Write a value; returns it, so `return store.set(k, v)` reads well. */
  set<T>(key: string, value: T): T;
  /** Read, initializing with `create()` on first access. */
  ensure<T>(key: string, create: () => T): T;
  /** Read-modify-write in one call; `create()` seeds a missing key. */
  update<T>(key: string, mutate: (current: T) => T, create: () => T): T;
  has(key: string): boolean;
  delete(key: string): boolean;
  /** Drop everything — used by tests and by a demo "reset" affordance. */
  clear(): void;
  keys(): string[];
}

export function createStore(): DemoStore {
  const values = new Map<string, unknown>();
  const store: DemoStore = {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): T {
      values.set(key, value);
      return value;
    },
    ensure<T>(key: string, create: () => T): T {
      if (!values.has(key)) values.set(key, create());
      return values.get(key) as T;
    },
    update<T>(key: string, mutate: (current: T) => T, create: () => T): T {
      const next = mutate(store.ensure(key, create));
      values.set(key, next);
      return next;
    },
    has: (key) => values.has(key),
    delete: (key) => values.delete(key),
    clear: () => values.clear(),
    keys: () => [...values.keys()].sort(),
  };
  return store;
}

/** The store every handler group shares. */
export const demoState: DemoStore = createStore();
