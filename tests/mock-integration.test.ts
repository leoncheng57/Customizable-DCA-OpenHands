import { beforeEach, describe, expect, it } from "vitest";
import { handlers as conversations } from "../client/mock/conversations.js";
import { handlers as manager } from "../client/mock/manager.js";
import { dispatch, registerGroup, resetRegistry } from "../client/mock/registry.js";
import { demoState } from "../client/mock/state.js";
import type { ConversationSummary } from "../client/lib/api.js";
import type { ConversationRole } from "../client/lib/manager-api.js";
import type { MockRequest } from "../client/mock/types.js";

function request(path: string): MockRequest {
  const url = new URL(`http://demo.test/api/openhands${path}`);
  return {
    method: "GET",
    path,
    params: {},
    query: url.searchParams,
    body: undefined,
    headers: new Headers(),
    url,
  };
}

async function get<T>(path: string): Promise<T> {
  const result = await dispatch(request(path));
  expect(result.status, `${path}: ${result.text}`).toBe(200);
  return JSON.parse(result.text) as T;
}

describe("demo conversation/manager integration", () => {
  beforeEach(() => {
    demoState.clear();
    resetRegistry();
    registerGroup(conversations);
    registerGroup(manager);
  });

  it("gives every manager and worker role a navigable conversation", async () => {
    const [{ roles }, { items }] = await Promise.all([
      get<{ roles: Record<string, ConversationRole> }>("/manager/conversation-roles"),
      get<{ items: ConversationSummary[] }>("/conversations"),
    ]);
    const conversationsById = new Map(items.map((item) => [item.id, item]));

    expect(Object.keys(roles).length).toBeGreaterThan(10);
    for (const id of Object.keys(roles)) {
      expect(conversationsById.has(id), `${id} appears in manager roles but not the Hub`).toBe(true);

      const detail = await get<ConversationSummary>(`/conversations/${id}`);
      expect(detail.id).toBe(id);

      const transcript = await get<{ items: unknown[] }>(`/conversations/${id}/events`);
      expect(transcript.items.length, `${id} has an empty transcript`).toBeGreaterThan(0);
    }
  });
});
