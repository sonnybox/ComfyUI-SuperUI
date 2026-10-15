// Comment and {a|b} dynamic prompt handling for the Dynamic Text node.
//
// Semantics deliberately mirror the stock frontend's processDynamicPrompt so
// text behaves the same as in nodes with dynamicPrompts: comments are removed
// first (escapes do not protect them), then choices resolve, then only \{ \}
// and \| are unescaped; any other backslash pair is left in the text as typed.
// Two differences: choices come from a seeded RNG instead
// of Math.random, so a fixed seed reproduces the same text, and a comment that
// is alone on its line takes the line's newline with it.

// Stock's regex (the last two alternatives), plus a first alternative that
// takes a comment filling its whole line together with that line's newline,
// so commented-out lines don't leave blank lines behind. Inline comments are
// removed exactly as in stock, keeping the text around them. An unclosed /*
// is not a comment and stays as text.
//
// The tempered (?!\*\/) keeps a whole-line block comment ending at its first
// */, rather than reaching ahead to a later */ that happens to end a line.
const COMMENT_RE =
  /^[ \t]*(?:\/\*(?:(?!\*\/)[\s\S])*\*\/|\/\/.*)[ \t]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/|\/\/.*/gm;

export function stripComments(text) {
  return text.replace(COMMENT_RE, "");
}

// mulberry32 seeded from both 32-bit halves of the seed, which can be up to
// 2^64 - 1 (precision above 2^53 is lost, but the mapping stays deterministic).
export function createRng(seed) {
  const n = Math.max(0, Math.floor(Number(seed) || 0));
  const lo = n % 4294967296;
  const hi = Math.floor(n / 4294967296) % 4294967296;
  let state =
    (Math.imul(lo ^ 0x9e3779b9, 0x85ebca6b) ^
      Math.imul((hi + 0x632be59b) | 0, 0xc2b2ae35)) >>>
    0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resolveChoices(text, rng) {
  let i = 0;
  let out = "";

  // A trailing backslash has nothing to escape; stock would emit "\undefined".
  const takeEscape = () => (i < text.length ? "\\" + text[i++] : "\\");

  function parseChoiceBlock() {
    const options = [];
    let current = "";
    let depth = 0;
    while (i < text.length) {
      const ch = text[i++];
      if (ch === "\\") {
        current += takeEscape();
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        if (!depth) break;
        depth--;
      } else if (ch === "|" && !depth) {
        options.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    options.push(current);
    return resolveChoices(options[Math.floor(rng() * options.length)], rng);
  }

  while (i < text.length) {
    const ch = text[i++];
    if (ch === "\\") out += takeEscape();
    else if (ch === "{") out += parseChoiceBlock();
    else out += ch;
  }
  return out.replace(/\\([{}|])/g, "$1");
}

export function resolveDynamicPrompt(text, seed) {
  return resolveChoices(stripComments(text), createRng(seed));
}

// True when the text has a {a|b} block with more than one option, i.e. when
// the seed actually changes the result.
export function hasChoices(text) {
  const stripped = stripComments(text);
  let depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "\\") i++;
    else if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "|" && depth > 0) return true;
  }
  return false;
}

// Splits text into highlight segments covering all of it:
// [{ start, end, kind, depth }]. kind is "comment", "syntax", "escape",
// "warning" or null for plain text; depth is how many {} groups the segment
// sits in, with a group's own braces counted at the group's depth.
export function tokenize(text) {
  const n = text.length;
  const kinds = new Array(n).fill(null);
  const depths = new Uint16Array(n);
  const commentAt = new Map();
  for (const m of text.matchAll(COMMENT_RE)) {
    commentAt.set(m.index, m.index + m[0].length);
  }

  const open = [];
  let depth = 0;
  const mark = (from, to, kind) => {
    for (let k = from; k < to; k++) {
      kinds[k] = kind;
      depths[k] = depth;
    }
  };

  let i = 0;
  while (i < n) {
    const commentEnd = commentAt.get(i);
    if (commentEnd !== undefined) {
      mark(i, commentEnd, "comment");
      i = commentEnd;
      continue;
    }
    const ch = text[i];
    // Comments are stripped before escapes are read, so a backslash cannot
    // escape the first character of one. Every backslash pair is consumed, as
    // the resolver does (so \\{ still opens a group), but only \{ \} and \|
    // are dimmed, since they are the only escapes the output drops the
    // backslash from; \( and the like stay as typed.
    if (ch === "\\" && i + 1 < n && !commentAt.has(i + 1)) {
      mark(i, i + 2, "{}|".includes(text[i + 1]) ? "escape" : null);
      i += 2;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      // Only reached when the regex found no closing */
      mark(i, i + 2, "warning");
      i += 2;
      continue;
    }
    if (ch === "{") {
      depth++;
      open.push(i);
      mark(i, i + 1, "syntax");
    } else if (ch === "}") {
      if (open.length) {
        mark(i, i + 1, "syntax");
        open.pop();
        depth--;
      } else {
        mark(i, i + 1, "warning");
      }
    } else if (ch === "|" && open.length) {
      mark(i, i + 1, "syntax");
    } else {
      mark(i, i + 1, null);
    }
    i++;
  }
  // Unclosed groups still resolve (to the end of the text), but almost always
  // by mistake.
  for (const k of open) kinds[k] = "warning";

  const segments = [];
  let start = 0;
  for (let k = 1; k <= n; k++) {
    if (k === n || kinds[k] !== kinds[start] || depths[k] !== depths[start]) {
      segments.push({ start, end: k, kind: kinds[start], depth: depths[start] });
      start = k;
    }
  }
  return segments;
}
