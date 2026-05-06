// Converts the model's Markdown output into Telegram-compatible HTML, then
// splits it into ≤max-char chunks at safe block boundaries.
//
// Why HTML and not MarkdownV2: Telegram's HTML mode allows ~10 tags and
// only requires escaping `< > &`, vs. MarkdownV2's 18 reserved characters.
// Production bridges that prioritise robustness uniformly converge on HTML.
//
// Telegram's HTML whitelist (anything else is rejected at send time):
//   <b>, <i>, <u>, <s>, <a href>, <code>, <pre>,
//   <pre><code class="language-X">, <blockquote>, <tg-spoiler>
//
// Strategy:
//   1. marked.lexer() turns the Markdown into a token tree.
//   2. We render each top-level block to a self-contained HTML string,
//      using only whitelisted tags.
//   3. packBlocks() greedily concatenates blocks (separated by \n\n) into
//      chunks ≤ MAX. Any single block over MAX gets split — for <pre><code>
//      we close-reopen the tag pair so each piece remains valid HTML.

import { marked, type Tokens, type Token } from "marked";

export const TELEGRAM_HARD_CAP = 4096;
// Default soft cap leaves headroom for a header line and a trailing marker.
export const TELEGRAM_SAFE_CAP = 3500;

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// ---- inline rendering ------------------------------------------------------

function renderInline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        // tokens may carry nested inline tokens (e.g. inside list items)
        out += tt.tokens ? renderInline(tt.tokens) : escHtml(tt.text);
        break;
      }
      case "escape":
        out += escHtml((t as Tokens.Escape).text);
        break;
      case "strong":
        out += `<b>${renderInline((t as Tokens.Strong).tokens)}</b>`;
        break;
      case "em":
        out += `<i>${renderInline((t as Tokens.Em).tokens)}</i>`;
        break;
      case "del":
        out += `<s>${renderInline((t as Tokens.Del).tokens)}</s>`;
        break;
      case "codespan":
        out += `<code>${escHtml((t as Tokens.Codespan).text)}</code>`;
        break;
      case "link": {
        const lk = t as Tokens.Link;
        out += `<a href="${escAttr(lk.href)}">${renderInline(lk.tokens)}</a>`;
        break;
      }
      case "image": {
        // Telegram has no inline image support in text — degrade to alt text.
        const im = t as Tokens.Image;
        out += escHtml(im.text || im.title || "[image]");
        break;
      }
      case "br":
        out += "\n";
        break;
      case "html":
        // Don't trust raw HTML in model output; escape it.
        out += escHtml((t as Tokens.HTML).text);
        break;
      default: {
        const txt = (t as { text?: unknown }).text;
        if (typeof txt === "string") out += escHtml(txt);
      }
    }
  }
  return out;
}

// ---- block rendering -------------------------------------------------------

// Render a single top-level block to a self-contained HTML string. Returning
// "" means "skip this token" (e.g. blank lines).
function renderBlock(t: Token): string {
  switch (t.type) {
    case "heading": {
      const h = t as Tokens.Heading;
      return `<b>${renderInline(h.tokens)}</b>`;
    }
    case "paragraph":
      return renderInline((t as Tokens.Paragraph).tokens);
    case "blockquote": {
      const bq = t as Tokens.Blockquote;
      const inner = bq.tokens.map(renderBlock).filter(Boolean).join("\n\n");
      return `<blockquote>${inner}</blockquote>`;
    }
    case "code": {
      const c = t as Tokens.Code;
      const lang = c.lang ? c.lang.split(/\s+/)[0] : "";
      const open = lang ? `<pre><code class="language-${escAttr(lang)}">` : "<pre>";
      const close = lang ? "</code></pre>" : "</pre>";
      return `${open}${escHtml(c.text)}${close}`;
    }
    case "list": {
      const l = t as Tokens.List;
      const lines: string[] = [];
      l.items.forEach((item, idx) => {
        const marker = l.ordered ? `${(typeof l.start === "number" ? l.start : 1) + idx}. ` : "• ";
        // Render item children: flatten nested paragraphs to a single newline.
        const inner = item.tokens.map(renderBlock).filter(Boolean).join("\n");
        lines.push(marker + inner);
      });
      return lines.join("\n");
    }
    case "hr":
      return "─────────────";
    case "table": {
      const tbl = t as Tokens.Table;
      const flatten = (inline: Token[] | undefined) =>
        renderInline(inline).replace(/<[^>]+>/g, ""); // strip tags inside <pre>
      const head = tbl.header.map((h) => flatten(h.tokens));
      const rows = tbl.rows.map((row) => row.map((c) => flatten(c.tokens)));
      const cols = head.length;
      const widths: number[] = [];
      for (let i = 0; i < cols; i++) {
        let w = head[i].length;
        for (const r of rows) w = Math.max(w, (r[i] ?? "").length);
        widths.push(w);
      }
      const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
      const lines = [
        head.map((h, i) => pad(h, widths[i])).join("  "),
        widths.map((w) => "─".repeat(w)).join("  "),
        ...rows.map((r) => r.map((c, i) => pad(c ?? "", widths[i])).join("  ")),
      ];
      return `<pre>${escHtml(lines.join("\n"))}</pre>`;
    }
    case "html":
      return escHtml((t as Tokens.HTML).text);
    case "space":
      return "";
    case "text": {
      // Loose list items show up as block-level "text" tokens whose `tokens`
      // field holds the inline tokens (where bold / code / links live).
      const tt = t as Tokens.Text;
      return tt.tokens ? renderInline(tt.tokens) : escHtml(tt.text);
    }
    default: {
      const txt = (t as { text?: unknown }).text;
      return typeof txt === "string" ? escHtml(txt) : "";
    }
  }
}

// ---- public API ------------------------------------------------------------

// Convert a Markdown string into a list of self-contained Telegram-HTML
// blocks, in document order. Each block is independently sendable.
export function markdownToTelegramBlocks(md: string): string[] {
  const tokens = marked.lexer(md);
  const blocks: string[] = [];
  for (const t of tokens) {
    const rendered = renderBlock(t);
    if (rendered) blocks.push(rendered);
  }
  return blocks;
}

// Pack a list of blocks into chunks ≤ max chars. Joins with a blank line.
// If any single block exceeds max, that block is split (preserving <pre>
// boundaries when possible) into multiple chunks.
export function packBlocks(blocks: string[], max: number = TELEGRAM_SAFE_CAP): string[] {
  const chunks: string[] = [];
  let cur = "";
  const flush = () => { if (cur) { chunks.push(cur); cur = ""; } };
  const append = (block: string) => {
    if (!cur) { cur = block; return; }
    if (cur.length + 2 + block.length > max) { flush(); cur = block; }
    else cur = `${cur}\n\n${block}`;
  };
  for (const block of blocks) {
    if (block.length <= max) { append(block); continue; }
    flush();
    for (const piece of splitOversizeBlock(block, max)) chunks.push(piece);
  }
  flush();
  return chunks;
}

// Split a single block whose length > max. For <pre> / <pre><code> blocks
// we close and reopen the tags on each piece so each chunk is valid HTML.
// Generic blocks fall back to hard-truncate with a marker.
function splitOversizeBlock(block: string, max: number): string[] {
  const preCode = /^<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>$/.exec(block);
  const preBare = /^<pre>([\s\S]*?)<\/pre>$/.exec(block);

  let inner: string | null = null;
  let open = "<pre>";
  let close = "</pre>";
  if (preCode) {
    inner = preCode[2];
    open = `<pre><code class="language-${escAttr(preCode[1])}">`;
    close = "</code></pre>";
  } else if (preBare) {
    inner = preBare[1];
  }

  if (inner !== null) {
    const overhead = open.length + close.length;
    const innerMax = Math.max(64, max - overhead);
    const pieces: string[] = [];
    let i = 0;
    while (i < inner.length) {
      let end = Math.min(i + innerMax, inner.length);
      if (end < inner.length) {
        // Prefer a newline boundary if there's one in the back half.
        const nl = inner.lastIndexOf("\n", end);
        if (nl > i + innerMax / 2) end = nl;
      }
      pieces.push(`${open}${inner.slice(i, end)}${close}`);
      i = end;
      if (inner[i] === "\n") i++;
    }
    return pieces;
  }

  const marker = "\n…(truncated)";
  return [block.slice(0, max - marker.length) + marker];
}

// Strip Telegram-HTML tags to produce a plain-text fallback. Used when a
// formatted send is rejected (rare — typically a model-injected unsupported
// tag we didn't catch). Keeps the message reaching the user.
export function stripTelegramHtml(html: string): string {
  return html
    // Drop tag pairs we know about; leave inner content
    .replace(/<\/?(?:b|i|u|s|strong|em|ins|strike|del|code|pre|a|blockquote|tg-spoiler)(?:\s+[^>]*)?>/gi, "")
    // Decode entities we emitted
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
