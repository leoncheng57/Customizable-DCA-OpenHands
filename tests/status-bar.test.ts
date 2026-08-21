// Bottom status bar (issue #43): folder, context fill, cost — all derived from
// the agent-server's `stats.usage_to_metrics`, whose shape is reproduced here
// from a live /api/conversations/<id> payload.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBar } from "../client/components/StatusBar.js";
import {
  contextTone,
  conversationCost,
  deriveStatusBar,
  formatCost,
  formatPercent,
  formatTokens,
  type StatusBarSource,
} from "../client/lib/statusBar.js";

const live: StatusBarSource = {
  workspace: { working_dir: "/home/openhands/workspace/local/customizable-dca-openhands" },
  metrics: null,
  stats: {
    usage_to_metrics: {
      default: {
        model_name: "anthropic/claude-opus-4-8",
        accumulated_cost: 0.0224,
        accumulated_token_usage: { prompt_tokens: 13340, completion_tokens: 344, context_window: 1_000_000, per_turn_token: 12884 },
        costs: [{ cost: 0.0044, timestamp: 1787204971 }, { cost: 0.018, timestamp: 1787204976 }],
        token_usages: [
          { prompt_tokens: 778, completion_tokens: 22, context_window: 1_000_000, per_turn_token: 800 },
          { prompt_tokens: 12562, completion_tokens: 322, context_window: 1_000_000, per_turn_token: 12884 },
        ],
      },
      condenser: {
        model_name: "anthropic/claude-opus-4-8",
        accumulated_cost: 0,
        accumulated_token_usage: { prompt_tokens: 0, completion_tokens: 0, context_window: 0, per_turn_token: 0 },
        costs: [],
        token_usages: [],
      },
      "anthropic/claude-fable-5": {
        model_name: "anthropic/claude-fable-5",
        accumulated_cost: 0.9016,
        accumulated_token_usage: { prompt_tokens: 356067, completion_tokens: 3735, context_window: 200_000, per_turn_token: 39582 },
        costs: [{ cost: 0.0057, timestamp: 1787204995 }, { cost: 0.0538, timestamp: 1787205106 }],
        token_usages: [{ prompt_tokens: 152000, completion_tokens: 418, context_window: 200_000, per_turn_token: 152418 }],
      },
    },
  },
};

describe("conversationCost", () => {
  it("sums every LLM the conversation used", () => {
    expect(conversationCost(live)).toBeCloseTo(0.924, 3);
  });

  it("falls back to the legacy metrics field when stats are absent", () => {
    expect(conversationCost({ metrics: { accumulated_cost: 0.5 } })).toBe(0.5);
    expect(conversationCost({})).toBeNull();
  });
});

describe("deriveStatusBar", () => {
  it("gauges the context of the most recently billed model, not the condenser", () => {
    const info = deriveStatusBar(live);
    expect(info.workingDir).toBe("/home/openhands/workspace/local/customizable-dca-openhands");
    expect(info.contextModel).toBe("anthropic/claude-fable-5");
    expect(info.contextTokens).toBe(152418);
    expect(info.contextWindow).toBe(200_000);
    expect(info.contextPct).toBeCloseTo(76.2, 1);
  });

  it("reports the last turn, not the accumulated total", () => {
    const single: StatusBarSource = {
      stats: {
        usage_to_metrics: {
          default: {
            accumulated_token_usage: { prompt_tokens: 13340, context_window: 1_000_000, per_turn_token: 12884 },
            token_usages: [
              { prompt_tokens: 778, completion_tokens: 22, context_window: 1_000_000, per_turn_token: 800 },
              { prompt_tokens: 12562, completion_tokens: 322, context_window: 1_000_000, per_turn_token: 12884 },
            ],
          },
        },
      },
    };
    expect(deriveStatusBar(single).contextTokens).toBe(12884);
  });

  it("adds up prompt and completion tokens when per_turn_token is missing", () => {
    const info = deriveStatusBar({
      stats: { usage_to_metrics: { default: { token_usages: [{ prompt_tokens: 900, completion_tokens: 100, context_window: 10_000 }] } } },
    });
    expect(info.contextTokens).toBe(1000);
    expect(info.contextPct).toBe(10);
  });

  it("yields nulls rather than zeros when the agent has not called an LLM yet", () => {
    const info = deriveStatusBar({ workspace: { working_dir: null }, stats: { usage_to_metrics: {} } });
    expect(info).toMatchObject({ workingDir: null, contextTokens: null, contextWindow: null, contextPct: null, cost: null });
  });
});

describe("formatting", () => {
  it("keeps costs readable at both ends", () => {
    expect(formatCost(0.9016)).toBe("$0.90");
    expect(formatCost(0.0004)).toBe("<$0.01");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(null)).toBeNull();
  });

  it("abbreviates token counts", () => {
    expect(formatTokens(842)).toBe("842");
    expect(formatTokens(12_884)).toBe("12.9K");
    expect(formatTokens(152_418)).toBe("152K");
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });

  it("never rounds a used context down to 0%", () => {
    expect(formatPercent(0.3)).toBe("<1%");
    expect(formatPercent(1.29)).toBe("1.3%");
    expect(formatPercent(76.2)).toBe("76%");
  });
});

describe("contextTone", () => {
  it("escalates as the window fills", () => {
    expect(contextTone(10)).toBe("normal");
    expect(contextTone(70)).toBe("warn");
    expect(contextTone(95)).toBe("danger");
    expect(contextTone(null)).toBe("normal");
  });
});

/** The `class="…"` of the element carrying `data-testid`, or null. */
function classesOf(html: string, testId: string): string | null {
  const tag = html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0];
  return tag?.match(/class="([^"]*)"/)?.[1] ?? null;
}

describe("<StatusBar>", () => {
  it("renders folder, context and cost in one line", () => {
    const html = renderToStaticMarkup(createElement(StatusBar, { conversation: live }));
    expect(html).toContain("customizable-dca-openhands");
    expect(html).toContain("76% context");
    expect(html).toContain("152K/200K");
    expect(html).toContain("$0.92");
    expect(html).toContain('data-tone="warn"');
  });

  // Two agents on sibling worktrees show the same basename, so the basename
  // cannot answer "which checkout is this?". The bar prints the whole path.
  it("prints the complete working dir, not just its basename", () => {
    const html = renderToStaticMarkup(createElement(StatusBar, { conversation: live }));
    expect(html).toContain("/home/openhands/workspace/local/customizable-dca-openhands");
  });

  it("scrolls the path rather than truncating or wrapping it", () => {
    const html = renderToStaticMarkup(createElement(StatusBar, { conversation: live }));
    const classes = classesOf(html, "status-bar-folder");
    expect(classes).not.toBeNull();
    // `truncate` is the regression this guards: it drops the tail, which is
    // the only part that distinguishes two worktrees of the same repo.
    expect(classes).not.toMatch(/\btruncate\b/);
    // Wrapping was the other candidate and is just as wrong here: at 390px
    // the path cell is ~90px wide, so a wrapped path turns a 25px status bar
    // into a 124px block. One line that scrolls, always.
    expect(classes).not.toMatch(/\bbreak-(all|words)\b/);
    expect(classes).toMatch(/\bwhitespace-nowrap\b/);
    expect(classes).toMatch(/\boverflow-x-auto\b/);
  });

  // The bar sits directly under the composer; both share a max-w-3xl track so
  // the two do not read as separate rails.
  it("keeps the composer's max-w-3xl track", () => {
    const html = renderToStaticMarkup(createElement(StatusBar, { conversation: live }));
    expect(html).toMatch(/class="[^"]*\bmax-w-3xl\b/);
    expect(classesOf(html, "openhands-status-bar")).toMatch(/\bshrink-0\b/);
  });

  it("degrades to the workspace hint before the first LLM call", () => {
    const html = renderToStaticMarkup(createElement(StatusBar, { conversation: null }));
    expect(html).toContain("no workspace");
    expect(html).not.toContain("context");
  });
});
