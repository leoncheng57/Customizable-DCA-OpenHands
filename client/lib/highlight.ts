// Zero-dependency syntax highlighting for the fenced code blocks in the
// Contributing docs (rendered by pages/DocPage.tsx).
//
// WHY NOT A LIBRARY. The repo rule is "no new runtime deps casually"
// (CONTRIBUTING.md), and the highlightable corpus is ~55 lines across three
// languages — shipping shiki (megabytes of TextMate grammars + themes) or
// highlight.js for that is not a trade worth making. `mermaid` fences are
// rendered as diagrams elsewhere and never reach this module.
//
// WHY THIS IS SAFE. Every language is a single left-to-right character
// scanner that consumes the input exactly once and emits one token per slice,
// so `highlight(code, lang).map(t => t.text).join("") === code` holds *by
// construction* for any input, valid or not. Mis-classification can therefore
// only ever tint a span the wrong colour; it can never reorder, drop or
// duplicate a character. tests/highlight.test.ts asserts that invariant over
// every fenced block in the real corpus plus a pile of adversarial inputs.
//
// WHY IT DEGRADES CLEANLY. `highlight()` returns `null` for any language it
// does not know (including no language at all, and `text`, which the corpus
// uses for ASCII trees and program output that must NOT be colourised). The
// caller renders the raw string in that case.

export type TokenKind =
  | "plain"
  /** `# …`, `// …`, or a block comment */
  | "comment"
  /** quoted string literal, including its quotes */
  | "string"
  /** language keyword or reserved literal (`if`, `const`, `true`, `null`, …) */
  | "keyword"
  /** numeric literal */
  | "number"
  /** object/mapping key (JSON, YAML) */
  | "key"
  /** shell variable expansion (`$VAR`, `${VAR}`) */
  | "variable";

export interface Token {
  kind: TokenKind;
  text: string;
}

/** Fence infostrings we highlight, normalised to one scanner each. */
const ALIASES: Record<string, "bash" | "json" | "ts" | "yaml"> = {
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  json: "json",
  jsonc: "json",
  ts: "ts",
  tsx: "ts",
  typescript: "ts",
  js: "ts",
  jsx: "ts",
  javascript: "ts",
  yaml: "yaml",
  yml: "yaml",
};

const BASH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "in", "function", "return", "export", "local", "readonly",
  "set", "unset", "source", "exit", "trap", "shift", "declare",
]);

const TS_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "declare", "default", "delete", "do", "else", "enum", "export", "extends",
  "finally", "for", "from", "function", "get", "if", "implements", "import",
  "in", "instanceof", "interface", "keyof", "let", "new", "of", "readonly",
  "return", "satisfies", "set", "static", "switch", "throw", "try", "type",
  "typeof", "var", "void", "while", "yield",
  "true", "false", "null", "undefined", "this", "super",
]);

const YAML_LITERALS = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

/** Push a slice, merging into the previous token when the kind matches so the
 * DOM gets one span per run instead of one per character. */
function push(out: Token[], kind: TokenKind, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

const isWordStart = (c: string) => /[A-Za-z_]/.test(c);
const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/** Consume a quoted run starting at `i` (src[i] is the quote). Always returns
 * an index past the closing quote, or `src.length` for an unterminated string
 * — never loops. `escapes` is false for shell single quotes, where a
 * backslash is a literal character. */
function readQuoted(src: string, i: number, escapes: boolean): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (escapes && c === "\\") {
      j += 2;
      continue;
    }
    j += 1;
    if (c === quote) break;
  }
  return Math.min(j, src.length);
}

function scanBash(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  // `#` only opens a comment at the start of a word, which is exactly what
  // keeps `https://host/page#frag` and `${x#y}` out of comment colouring.
  let atWordStart = true;
  while (i < src.length) {
    const c = src[i];
    if (c === "#" && atWordStart) {
      let end = src.indexOf("\n", i);
      if (end === -1) end = src.length;
      push(out, "comment", src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = readQuoted(src, i, c === '"');
      push(out, "string", src.slice(i, end));
      i = end;
      atWordStart = false;
      continue;
    }
    if (c === "$" && i + 1 < src.length && (isWordStart(src[i + 1]) || src[i + 1] === "{")) {
      let j = i + 1;
      if (src[j] === "{") {
        const close = src.indexOf("}", j);
        j = close === -1 ? src.length : close + 1;
      } else {
        while (j < src.length && isWord(src[j])) j += 1;
      }
      push(out, "variable", src.slice(i, j));
      i = j;
      atWordStart = false;
      continue;
    }
    if (isWordStart(c)) {
      let j = i;
      while (j < src.length && isWord(src[j])) j += 1;
      const word = src.slice(i, j);
      // A keyword only counts as one when it stands alone: `in` inside
      // `--install` or `set` in `setup.sh` must stay plain.
      const boundedRight = j >= src.length || !/[-.\w/]/.test(src[j]);
      push(out, BASH_KEYWORDS.has(word) && atWordStart && boundedRight ? "keyword" : "plain", word);
      i = j;
      atWordStart = false;
      continue;
    }
    push(out, "plain", c);
    atWordStart = c === "\n" || c === " " || c === "\t" || c === ";" || c === "|" || c === "(";
    i += 1;
  }
  return out;
}

function scanJson(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      const end = readQuoted(src, i, true);
      // A string is a key when the next non-space character is a colon.
      let k = end;
      while (k < src.length && /\s/.test(src[k])) k += 1;
      push(out, src[k] === ":" ? "key" : "string", src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      // jsonc — tolerated because the fence may be labelled `json`.
      let end: number;
      if (src[i + 1] === "/") {
        end = src.indexOf("\n", i);
        if (end === -1) end = src.length;
      } else {
        const close = src.indexOf("*/", i + 2);
        end = close === -1 ? src.length : close + 2;
      }
      push(out, "comment", src.slice(i, end));
      i = end;
      continue;
    }
    if (isDigit(c) || (c === "-" && isDigit(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      push(out, "number", src.slice(i, j));
      i = j;
      continue;
    }
    if (isWordStart(c)) {
      let j = i;
      while (j < src.length && isWord(src[j])) j += 1;
      const word = src.slice(i, j);
      push(out, word === "true" || word === "false" || word === "null" ? "keyword" : "plain", word);
      i = j;
      continue;
    }
    push(out, "plain", c);
    i += 1;
  }
  return out;
}

function scanTs(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let end = src.indexOf("\n", i);
      if (end === -1) end = src.length;
      push(out, "comment", src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close + 2;
      push(out, "comment", src.slice(i, end));
      i = end;
      continue;
    }
    // Template literals are consumed whole, interpolations included. Colouring
    // `${…}` as code would need a real parser; a uniformly-tinted template is
    // honest and never mangles.
    if (c === '"' || c === "'" || c === "`") {
      const end = readQuoted(src, i, true);
      push(out, "string", src.slice(i, end));
      i = end;
      continue;
    }
    if (isDigit(c)) {
      let j = i;
      while (j < src.length && /[0-9._a-fA-FxXoObBnE+-]/.test(src[j])) {
        // Stop before a `-`/`+` that isn't an exponent sign, so `3-x` splits.
        if ((src[j] === "-" || src[j] === "+") && !/[eE]/.test(src[j - 1])) break;
        j += 1;
      }
      push(out, "number", src.slice(i, j));
      i = j;
      continue;
    }
    if (isWordStart(c) || c === "$") {
      let j = i + 1;
      while (j < src.length && (isWord(src[j]) || src[j] === "$")) j += 1;
      const word = src.slice(i, j);
      // Not a keyword when it's a property access (`obj.type`) or a key
      // (`type:` in an object literal is fine to leave plain either way).
      const isMember = src[i - 1] === ".";
      push(out, !isMember && TS_KEYWORDS.has(word) ? "keyword" : "plain", word);
      i = j;
      continue;
    }
    push(out, "plain", c);
    i += 1;
  }
  return out;
}

function scanYaml(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let lineStart = true;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      push(out, "plain", c);
      lineStart = true;
      i += 1;
      continue;
    }
    // Comments open at the start of a line or after whitespace, never mid-token
    // (so `http://x#y` and `key: a#b` stay intact).
    if (c === "#" && (i === 0 || /[\s]/.test(src[i - 1]))) {
      let end = src.indexOf("\n", i);
      if (end === -1) end = src.length;
      push(out, "comment", src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = readQuoted(src, i, c === '"');
      push(out, "string", src.slice(i, end));
      i = end;
      lineStart = false;
      continue;
    }
    if (lineStart && /[ \t]/.test(c)) {
      let j = i;
      while (j < src.length && /[ \t]/.test(src[j])) j += 1;
      push(out, "plain", src.slice(i, j));
      i = j;
      continue;
    }
    if (lineStart && c === "-" && /[\s]/.test(src[i + 1] ?? " ")) {
      push(out, "plain", c);
      i += 1;
      continue; // stay in lineStart: `- key: value` still has a key
    }
    if (lineStart && /[A-Za-z_"'.]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w.\-/]/.test(src[j])) j += 1;
      const after = src[j];
      if (after === ":" && (j + 1 >= src.length || /[\s]/.test(src[j + 1]))) {
        push(out, "key", src.slice(i, j));
        i = j;
        lineStart = false;
        continue;
      }
    }
    if (isWordStart(c) || c === "~") {
      let j = i;
      while (j < src.length && isWord(src[j])) j += 1;
      if (j === i) j = i + 1; // lone `~`
      const word = src.slice(i, j);
      push(out, YAML_LITERALS.has(word.toLowerCase()) ? "keyword" : "plain", word);
      i = j;
      lineStart = false;
      continue;
    }
    if (isDigit(c)) {
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j])) j += 1;
      push(out, "number", src.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    push(out, "plain", c);
    lineStart = false;
    i += 1;
  }
  return out;
}

const SCANNERS = { bash: scanBash, json: scanJson, ts: scanTs, yaml: scanYaml } as const;

/** Language from a react-markdown `className` such as "language-bash". */
export function languageFromClassName(className?: string): string | undefined {
  return /(?:^|\s)language-([\w+-]+)/.exec(className ?? "")?.[1];
}

/**
 * Tokenise `code` for `lang`, or return `null` when the language is unknown
 * or deliberately unhighlighted (`text`, `console` output, no infostring) so
 * the caller can render the original string untouched.
 */
export function highlight(code: string, lang?: string): Token[] | null {
  const scanner = SCANNERS[ALIASES[(lang ?? "").toLowerCase()] as keyof typeof SCANNERS];
  if (!scanner) return null;
  return scanner(code);
}
