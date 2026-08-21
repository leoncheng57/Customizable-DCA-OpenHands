/**
 * Thin agent-server client for the manager feature.
 *
 * Built on the same `createUpstream` primitive the BFF and auto-resumer use
 * (X-Session-API-Key auth, lazy key-file read, per-call timeout). This is the
 * ONLY module in the manager feature that talks to the agent-server; the
 * executor and monitor go through it so tests can stub one seam.
 */

import { randomUUID } from "node:crypto";
import type { UpstreamFetch } from "../upstream.js";
import { messageContent, sessionWorkingDir } from "../setup.js";
import { conversationAgentSettings, type UpstreamAgentSettings } from "../agentSettings.js";

export interface ConversationInfo {
  id: string;
  execution_status?: string;
  updated_at?: string;
  title?: string;
}

export interface ConversationEvent {
  id?: string;
  kind?: string;
  timestamp?: string;
  source?: string;
  llm_message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

export interface ManagerAgentClient {
  /**
   * Create a conversation in its own sessions/<uuid> working dir and start
   * the run. Returns the minted conversation id.
   */
  createConversation(input: {
    initialMessage: string;
    model: string;
  }): Promise<string>;
  /** Send a user message; `run: true` restarts the agent loop. */
  sendMessage(conversationId: string, text: string): Promise<void>;
  /** Switch the conversation's LLM for subsequent steps. */
  switchModel(conversationId: string, model: string): Promise<void>;
  getConversation(conversationId: string): Promise<ConversationInfo | null>;
  /** Newest-first page of events (server caps pages at 100). */
  listRecentEvents(
    conversationId: string,
    limit?: number,
  ): Promise<ConversationEvent[]>;
}

export function createManagerAgentClient(
  upstream: UpstreamFetch,
): ManagerAgentClient {
  return {
    async createConversation({ initialMessage, model }) {
      const conversationId = randomUUID();
      // Manager runs are ordinary conversations, so they inherit the same
      // agent-server gap: a create request carrying `agent_settings` never
      // picks up the persisted default profile. Forward it here too, or every
      // worker runs with the stock condenser and no skills.
      let persisted: UpstreamAgentSettings | null = null;
      try {
        const settingsRes = await upstream("/api/settings");
        if (settingsRes.ok) persisted = (await settingsRes.json()) as UpstreamAgentSettings;
      } catch {
        /* best-effort: fall back to the stock defaults rather than fail the run */
      }
      const res = await upstream("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: conversationId,
          workspace: {
            kind: "LocalWorkspace",
            working_dir: sessionWorkingDir(conversationId),
          },
          confirmation_policy: { kind: "NeverConfirm" },
          agent_settings: conversationAgentSettings(persisted, { model, stream: true }),
          initial_message: {
            role: "user",
            content: messageContent(initialMessage, []),
          },
        }),
      });
      if (!res.ok) {
        throw new Error(`agent-server create failed: HTTP ${res.status}`);
      }
      const conv = (await res.json()) as { id?: string };
      if (conv.id !== conversationId) {
        throw new Error("agent-server returned a different conversation id");
      }
      // 409 "already running" is success — initial_message starts the loop.
      const run = await upstream(
        `/api/conversations/${conversationId}/run`,
        { method: "POST", body: "{}" },
      );
      if (!run.ok && run.status !== 409) {
        throw new Error(`agent-server run failed: HTTP ${run.status}`);
      }
      return conversationId;
    },

    async sendMessage(conversationId, text) {
      const res = await upstream(`/api/conversations/${conversationId}/events`, {
        method: "POST",
        body: JSON.stringify({
          role: "user",
          content: messageContent(text, []),
          run: true,
        }),
      });
      if (!res.ok) {
        throw new Error(`agent-server send failed: HTTP ${res.status}`);
      }
    },

    async switchModel(conversationId, model) {
      // usage_id keys the agent-server's per-conversation LLM registry
      // (first-write-wins), so the model id itself is the key: switching back
      // to a previously used model reuses its cached LLM (same pattern as the
      // BFF's send-with-model path).
      const res = await upstream(`/api/conversations/${conversationId}/switch_llm`, {
        method: "POST",
        body: JSON.stringify({ llm: { model, usage_id: model } }),
      });
      if (!res.ok) {
        throw new Error(`agent-server switch_llm failed: HTTP ${res.status}`);
      }
    },

    async getConversation(conversationId) {
      const res = await upstream(`/api/conversations/${conversationId}`);
      if (!res.ok) return null;
      return (await res.json()) as ConversationInfo;
    },

    async listRecentEvents(conversationId, limit = 30) {
      const pageLimit = Math.min(limit, 100);
      // Preferred: newest-first, one page (the bash_events search endpoint
      // supports sort_order; events/search shares the framework).
      const desc = await upstream(
        `/api/conversations/${conversationId}/events/search?limit=${pageLimit}&sort_order=TIMESTAMP_DESC`,
        undefined,
        10_000,
      );
      if (desc.ok) {
        const body = (await desc.json()) as { items?: ConversationEvent[] };
        if (Array.isArray(body.items)) return body.items;
      }
      // Fallback for agent-server versions without sort_order: walk ascending
      // pages and keep the tail. Manager conversations stay small, so this is
      // bounded in practice.
      const tail: ConversationEvent[] = [];
      let pageId: string | undefined;
      for (let page = 0; page < 50; page++) {
        const qs = new URLSearchParams({ limit: "100" });
        if (pageId) qs.set("page_id", pageId);
        const res = await upstream(
          `/api/conversations/${conversationId}/events/search?${qs.toString()}`,
          undefined,
          10_000,
        );
        if (!res.ok) break;
        const body = (await res.json()) as {
          items?: ConversationEvent[];
          next_page_id?: string | null;
        };
        tail.push(...(body.items ?? []));
        if (tail.length > 300) tail.splice(0, tail.length - 300);
        if (!body.next_page_id) break;
        pageId = body.next_page_id;
      }
      return tail.slice(-pageLimit).reverse();
    },
  };
}
