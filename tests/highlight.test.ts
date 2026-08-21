// The zero-dependency code tokeniser behind the Contributing reader's fenced
// code blocks (client/lib/highlight.ts).
//
// The load-bearing assertion is `losslessness`: every scanner must emit tokens
// whose concatenation is byte-identical to its input. That is what makes a
// hand-written highlighter acceptable here instead of a real grammar — a
// mis-classified token can only ever be the wrong colour, never a mangled or
// dropped line of code. It is asserted over every fenced block in the real
// corpus plus adversarial inputs, so the guarantee survives new docs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS } from "../client/lib/docs.js";
import { highlight, languageFromClassName, type Token } from "../client/lib/highlight.js";

const ROOT = join(__dirname, "..");

/** Every fenced block in the corpus, with its infostring. */
function fencedBlocks(): { path: string; lang: string; code: string }[] {
  const out: { path: string; lang: string; code: string }[] = [];
  for (const doc of DOCS) {
    const lines = readFileSync(join(ROOT, doc.path), "utf8").split("\n");
    let lang: string | null = null;
    let buf: string[] = [];
    for (const line of lines) {
      const open = /^```(\S*)\s*$/.exec(line);
      if (lang === null && open) {
        lang = open[1];
        buf = [];
      } else if (lang !== null && line.trim() === "```") {
        out.push({ path: doc.path, lang, code: `${buf.join("\n")}\n` });
        lang = null;
      } else if (lang !== null) {
        buf.push(line);
      }
    }
  }
  return out;
}

const BLOCKS = fencedBlocks();
const kinds = (tokens: Token[] | null) => new Set((tokens ?? []).map((t) => t.kind));
const textOf = (tokens: Token[] | null, kind: string) =>
  (tokens ?? []).filter((t) => t.kind === kind).map((t) => t.text);

const LANGS = ["bash", "sh", "shell", "zsh", "json", "jsonc", "ts", "tsx", "js", "javascript", "typescript", "yaml", "yml"];

const ADVERSARIAL = [
  "", "\n", "   ", "#", "'", '"', "`", "\\", "'unterminated", '"unterminated\\', "`unterminated ${",
  "/*", "//", "/* unclosed", "${", "$", "${unclosed", "0x", "1e", "-", "- ", ":", "a:",
  "#!/usr/bin/env bash\necho 'hi' # done\n",
  "curl https://example.com/page#frag -o - | bash # real comment\n",
  "echo \"a # not a comment\" # but this is\n",
  "echo 'it'\\''s tricky' # quoted\n",
  "{\"a\":1,\"b\":[true,null,-2.5e3],\"c\":{\"d\":\"x\\\"y\"}}\n",
  "const s = `tpl ${a + `${b}`} end`; // note\n",
  "key: value # c\nlist:\n  - one\n  - two: 3\nurl: http://x/y#z\n",
  "\u0000\u001b[31mred\u001b[0m\n",
  "emoji 🚀 and ünïcode\n",
  "a".repeat(5000),
];

describe("highlight", () => {
  it("returns null for languages it does not claim", () => {
    // `text` is used by the corpus for ASCII trees and program output, which
    // must stay uncoloured; mermaid never reaches this module.
    for (const lang of ["text", "mermaid", "", undefined, "rust", "diff", "TEXT", "plaintext"]) {
      expect(highlight("anything", lang), `${lang} should not be highlighted`).toBeNull();
    }
  });

  it("claims the languages the corpus actually uses", () => {
    const used = new Set(BLOCKS.map((b) => b.lang).filter((l) => l && l !== "mermaid" && l !== "text"));
    expect(used.size, "expected highlightable fences in the corpus").toBeGreaterThan(0);
    for (const lang of used) expect(highlight("x", lang), `corpus uses \`\`\`${lang}`).not.toBeNull();
  });

  describe("losslessness — tokens always reassemble the input exactly", () => {
    it.each(LANGS)("%s: adversarial inputs", (lang) => {
      for (const code of ADVERSARIAL) {
        const tokens = highlight(code, lang)!;
        expect(tokens.map((t) => t.text).join(""), `${lang} mangled ${JSON.stringify(code.slice(0, 40))}`).toBe(code);
      }
    });

    it.each(LANGS)("%s: every fenced block in the corpus, regardless of its real language", (lang) => {
      // Cross-feeding every block to every scanner is deliberate: it exercises
      // the scanners against far more shapes than the corpus alone provides.
      for (const block of BLOCKS) {
        const tokens = highlight(block.code, lang)!;
        expect(tokens.map((t) => t.text).join(""), `${lang} mangled a block from ${block.path}`).toBe(block.code);
      }
    });

    it("never emits an empty token", () => {
      for (const lang of LANGS) {
        for (const code of [...ADVERSARIAL, ...BLOCKS.map((b) => b.code)]) {
          expect(highlight(code, lang)!.every((t) => t.text.length > 0)).toBe(true);
        }
      }
    });
  });

  describe("bash", () => {
    it("colours trailing annotation comments — the corpus's dominant pattern", () => {
      const t = highlight("npm run typecheck        # client tsconfig, --noEmit\n", "bash");
      expect(textOf(t, "comment")).toEqual(["# client tsconfig, --noEmit"]);
    });

    it("does not mistake a URL fragment for a comment", () => {
      const t = highlight("curl https://example.com/a#b -o out\n", "bash");
      expect(kinds(t).has("comment")).toBe(false);
    });

    it("keeps a `#` inside quotes out of comment colouring", () => {
      const t = highlight(`curl -w '%{http_code}#x' localhost # real\n`, "bash");
      expect(textOf(t, "string")).toEqual([`'%{http_code}#x'`]);
      expect(textOf(t, "comment")).toEqual(["# real"]);
    });

    it("treats a shebang as a comment", () => {
      expect(textOf(highlight("#!/bin/sh\n", "bash"), "comment")).toEqual(["#!/bin/sh"]);
    });

    it("marks keywords only when they stand alone as a word", () => {
      expect(textOf(highlight("export FOO=1\n", "bash"), "keyword")).toEqual(["export"]);
      // `in`/`set`/`do` hide inside real command names and flags constantly.
      for (const line of ["docker inspect x\n", "setup.sh\n", "--install\n", "npm install\n", "dosomething\n"]) {
        expect(kinds(highlight(line, "bash")).has("keyword"), line).toBe(false);
      }
    });

    it("marks variable expansions", () => {
      expect(textOf(highlight("echo $HOME ${X}\n", "bash"), "variable")).toEqual(["$HOME", "${X}"]);
      expect(kinds(highlight("cost: $5\n", "bash")).has("variable")).toBe(false);
    });
  });

  describe("json", () => {
    const t = highlight('{"name": "x", "n": -1.5, "ok": true, "z": null}', "json");
    it("separates keys from string values", () => {
      expect(textOf(t, "key")).toEqual(['"name"', '"n"', '"ok"', '"z"']);
      expect(textOf(t, "string")).toEqual(['"x"']);
    });
    it("marks numbers and literals", () => {
      expect(textOf(t, "number")).toEqual(["-1.5"]);
      expect(textOf(t, "keyword")).toEqual(["true", "null"]);
    });
    it("survives an escaped quote inside a key", () => {
      const e = highlight('{"a\\"b": 1}', "json");
      expect(textOf(e, "key")).toEqual(['"a\\"b"']);
    });
  });

  describe("ts", () => {
    const t = highlight('const a = "s"; // note\n/* block */ export type X = 1;\n', "ts");
    it("marks comments, strings and keywords", () => {
      expect(textOf(t, "comment")).toEqual(["// note", "/* block */"]);
      expect(textOf(t, "string")).toEqual(['"s"']);
      expect(textOf(t, "keyword")).toEqual(expect.arrayContaining(["const", "export", "type"]));
    });
    it("does not treat a property access as a keyword", () => {
      expect(kinds(highlight("obj.type\n", "ts")).has("keyword")).toBe(false);
    });
    it("consumes a template literal whole, interpolation included", () => {
      expect(textOf(highlight("`a ${b} c`", "ts"), "string")).toEqual(["`a ${b} c`"]);
    });
    it("does not read a URL inside a string as a comment", () => {
      expect(kinds(highlight('const u = "https://x.dev";', "ts")).has("comment")).toBe(false);
    });
  });

  describe("yaml", () => {
    const t = highlight("on: push\njobs:\n  - name: x # c\n    ok: true\n", "yaml");
    it("marks mapping keys, literals and comments", () => {
      expect(textOf(t, "key")).toEqual(expect.arrayContaining(["on", "jobs", "name", "ok"]));
      expect(textOf(t, "keyword")).toEqual(["true"]);
      expect(textOf(t, "comment")).toEqual(["# c"]);
    });
    it("does not read a mid-token `#` as a comment", () => {
      expect(kinds(highlight("url: http://x/y#z\n", "yaml")).has("comment")).toBe(false);
    });
  });
});

describe("languageFromClassName", () => {
  it.each([
    ["language-bash", "bash"],
    ["language-ts", "ts"],
    ["foo language-json bar", "json"],
    ["language-objective-c", "objective-c"],
    ["hljs", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("%j → %j", (input, expected) => {
    expect(languageFromClassName(input)).toBe(expected);
  });
});
