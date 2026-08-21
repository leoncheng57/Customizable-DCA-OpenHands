# Design system

The app vendors a **tiny, dependency-free design system** instead of pulling a component
library. Eight primitives + a token sheet + Tailwind v4. This was a deliberate extraction
choice (decisions.md #3): only the components actually used were copied from the source
platform, and its private theme package was replaced by local CSS custom properties.

## Layers

```text
client/theme/tokens.css           ← generated token sheet (--ui-*): base palette, spacing,
client/theme/tailwind-bridge.css     typography. Treat as read-only vendored artifacts.
            │
            ▼
client/styles.css                 ← the file you actually edit:
                                     · Tailwind v4 entry (@import "tailwindcss")
                                     · semantic tokens (--color-text-default,
                                       --color-background-surface, --color-border-default, …)
                                     · light/dark overrides (next-themes toggles `class`)
                                     · app-specific pieces (.app-navbar island, .app-nav-item,
                                       .prose-ui typography, accent variables --app-accent-*)
            │
            ▼
client/ds/                        ← 7 primitives consuming ONLY those semantic tokens
```

## The primitives (`client/ds/`)

| Component | Notes |
|---|---|
| `button.tsx` | `variant`: primary / secondary / danger / ghost + legacy `accent-*` pills; sizes sm/md/lg |
| `badge.tsx` | `variant`: neutral / info / success / warning / danger / pro / beta — muted surface + tinted outline |
| `card.tsx` | Card/CardHeader/CardTitle/CardContent…, collapsible header support |
| `alert.tsx` | inline callouts |
| `table.tsx` | `Table, THead, TBody, TR, TH, TD` — thin styled wrappers |
| `loading-indicator.tsx` | spinner |
| `markdown.tsx` | regex-chain renderer for **small slices of LLM prose** (see below) |
| `command-palette.tsx` | Cmd/Ctrl+K overlay — the app's only portal/modal and only ARIA listbox (decisions.md #16) |
| `utils.ts` | `cn()` = clsx + tailwind-merge |

Rules of the directory:

- **No dependencies** beyond React, `clsx`/`tailwind-merge`, `lucide-react` icons.
- **Only semantic tokens** — a DS component never hardcodes a palette hex; it uses
  `var(--color-…)` so light/dark theming stays centralized in `styles.css`.
- Copy-paste-extend is fine: these are owned files, not a library. If you need a `Tabs`, add
  `tabs.tsx` in the same style.

## Two markdown renderers — pick correctly

| Renderer | Use for | Why |
|---|---|---|
| `client/ds/markdown.tsx` (`<Markdown>`) | short LLM/assistant prose in the transcript | tiny, fast, hardened (`untrusted` mode escapes HTML + restricts protocols) |
| `react-markdown` + `remark-gfm` (used by the Contributing doc viewer) | full documents: fenced code, GFM tables, mermaid | the DS renderer's own header says so: don't extend the regex chain |

If you touch `ds/markdown.tsx`: it renders via `dangerouslySetInnerHTML` — its escaping rules
(placeholder stash, attribute-escaping, protocol allowlist) are security-relevant. Read the
header comment first; it's on the [risk map](risk-map.md) via the DS area.

## Theming

- `next-themes` with `attribute="class"` — dark mode is `.dark` on `<html>`, system-following
  by default; toggle in the navbar (`main.tsx`).
- Accent identity lives in a few `--app-*` variables (logo gradient, nav active state,
  primary action green). **Rebranding a fork ≈ editing `styles.css` tokens + `LogoMark` in
  `main.tsx`** — no component changes needed.
- Typography for rendered prose is the `.prose-ui` class in `styles.css` (headings, lists,
  tables, code) — shared by the transcript renderer and doc pages.

## Icons

`lucide-react` throughout (nav icons are ~14 px, `strokeWidth` ≈ 2.2). Don't mix icon sets.

## Adding UI without breaking the system

1. Reach for an existing primitive; compose in the page/component layer.
2. Need a new primitive? Add it to `client/ds/` following the local style (forwardRef,
   `cn()` merging, semantic tokens, variants as string unions).
3. Page-specific styling stays in the page via Tailwind utilities; new *shared* patterns get a
   class in `styles.css` (see `.app-navbar`).
4. Overlays: there is one stacking ladder — navbar `z-40`, the conversation sidebar's drag
   shield `z-50`, the command palette `z-[60]`. Anything that must float above the palette
   picks up from there, and anything modal should portal to `<body>` for the same reason the
   palette does (the conversation page nests stacking contexts that would clip it).
4. Diagrams on doc-style pages: prefer the shared doc tooling (mermaid/ASCII in markdown,
   or React Flow on the Contributing index) over bespoke styled-div diagrams.
