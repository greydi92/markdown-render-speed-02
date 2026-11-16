// marked-faster: a dependency-free CommonMark 0.31.2 + GFM renderer
// written to match marked 18.1.3 (default options) byte for byte.
// Single file, no imports. Block phase then inline phase.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function entityRefAt(s, i) {
  // does s starting at i hold a valid entity reference? returns its length or 0
  // Entity refs are short (longest named entity ~32 chars), so only the
  // next 40 chars are ever examined — never a slice of the whole rest.
  const m = /^&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/.exec(s.slice(i, i + 40));
  if (!m) return 0;
  const body = m[0].slice(1, -1);
  if (body[0] === '#') {
    let cp;
    if (body[1] === 'x' || body[1] === 'X') cp = parseInt(body.slice(2), 16);
    else cp = parseInt(body.slice(1), 10);
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return 0;
  }
  return m[0].length;
}
export function escapeHtml(s) {
  // text/attribute escaping: keep a valid entity reference intact, escape
  // any other & (marked never decodes named entities in text).
  // No '&' means no entity can occur: one C-level replace handles the
  // remaining escapables (<, >, ", '); no match at all returns s as-is.
  if (!s.includes('&')) {
    return /[<>"']/.test(s) ? s.replace(/[<>"']/g, (c) => ESC[c]) : s;
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const len = entityRefAt(s, i);
      if (len) { out += s.slice(i, i + len); i += len - 1; continue; }
      out += '&amp;';
    } else out += ESC[c] || c;
  }
  return out;
}
function escapeCode(s) {
  // code content: every & is escaped, entities are literal text.
  // One C-level replace (callback per match; matches are rare).
  return /[&<>"']/.test(s) ? s.replace(/[&<>"']/g, (c) => ESC[c]) : s;
}
const escapeAttr = (s) => escapeHtml(s);

function decodeEntity(str, i) {
  // str[i] === '&'; decode NUMERIC references only (named ones stay
  // literal in marked's output). Returns [char, nextIndex] or null.
  if (str[i + 1] !== '#') return null;
  let j = i + 2, hex = false;
  if (str[j] === 'x' || str[j] === 'X') { hex = true; j++; }
  const start = j;
  while (j < str.length && (hex ? /[0-9A-Fa-f]/.test(str[j]) : /[0-9]/.test(str[j]))) j++;
  if (j === start || str[j] !== ';') return null;
  const cp = parseInt(str.slice(start, j), hex ? 16 : 10);
  if (cp > 0x10FFFF) return null;
  if (!cp || (cp >= 0xD800 && cp <= 0xDFFF)) return ['\uFFFD', j + 1];
  return [String.fromCodePoint(cp), j + 1];
}

// ---- character classes ----
// ASCII punctuation per Unicode \p{P} + \p{S}: 33-47, 58-64, 91-96, 123-126.
// Lookup tables keep the per-character tests to one array read; only
// non-ASCII chars fall back to the regexes.
const PUNCT_ASCII = new Uint8Array(128);
for (let c = 33; c <= 47; c++) PUNCT_ASCII[c] = 1;
for (let c = 58; c <= 64; c++) PUNCT_ASCII[c] = 1;
for (let c = 91; c <= 96; c++) PUNCT_ASCII[c] = 1;
for (let c = 123; c <= 126; c++) PUNCT_ASCII[c] = 1;
const PUNCT = /[\p{P}\p{S}]/u;
const isPunct = (c) => {
  if (!c) return false;
  const code = c.charCodeAt(0);
  return code < 128 ? !!PUNCT_ASCII[code] : PUNCT.test(c);
};
const ASCII_PUNCT = (c) => {
  if (!c) return false;
  const code = c.charCodeAt(0);
  return code < 128 ? !!PUNCT_ASCII[code] : /[!-\/:-@\[-`{-~]/.test(c);
};
const isWs = (c) => {
  if (!c) return false;
  const code = c.charCodeAt(0);
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11 || (code >= 128 && /\s/.test(c));
};

// ---- tab-aware line helpers ----
function indentInfo(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, idx: i };
}
function stripCols(line, n) {
  // remove n columns of leading indent; a straddling tab becomes spaces
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}
const isBlank = (line) => /^[ \t]*$/.test(line);
// marked's fence-content dedent (Dt) only applies to BACKTICK fences:
// it matches /^(\s+)(?:```)/ on the fence text, so a tilde fence keeps
// its content indentation verbatim. For a backtick fence Dt strips
// min(leading-whitespace-chars, fence-indent-chars) CHARACTERS from
// each content line — a tab counts as one character, not a column width.
const stripFence = (L, n) => {
  const m = /^\s+/.exec(L);
  return m ? L.slice(Math.min(m[0].length, n)) : L;
};
const leadWs = (line) => { const m = /^[ \t]*/.exec(line); return m[0].length; };

// ---- link reference definitions ----
const CASEFOLD = { '\u00df': 'ss', '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st', '\u01C6': 'd\u017E', '\u01C9': 'lj', '\u01CC': 'nj', '\u01F3': 'dz' };
function normLabel(s) {
  // labels compare on the raw text (case-folded, whitespace collapsed);
  // backslash escapes are NOT undone when matching.
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[\u00df\uFB00-\uFB06\u01C6\u01C9\u01CC\u01F3]/g, (ch) => CASEFOLD[ch]);
}
function unescapeText(s) {
  // backslash escapes only; entities stay literal (marked's rule).
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}
function parseTitle(s) {
  s = s.replace(/^[ \t]+/, '');
  if (!s) return null;
  const q = s[0];
  if (q === '"' || q === "'") {
    let j = 1, out = '';
    while (j < s.length) {
      if (s[j] === '\\' && j + 1 < s.length && ASCII_PUNCT(s[j + 1])) { out += s[j + 1]; j += 2; }
      else if (s[j] === q) return { title: out, rest: s.slice(j + 1) };
      else { out += s[j]; j++; }
    }
    return null;
  }
  if (q === '(') {
    let j = 1, depth = 1, out = '';
    while (j < s.length) {
      if (s[j] === '\\' && j + 1 < s.length && ASCII_PUNCT(s[j + 1])) { out += s[j + 1]; j += 2; }
      else if (s[j] === '(') { depth++; out += s[j]; j++; }
      else if (s[j] === ')') { depth--; if (!depth) return { title: out, rest: s.slice(j + 1) }; out += s[j]; j++; }
      else { out += s[j]; j++; }
    }
    return null;
  }
  return null;
}
function readDest(s) {
  // parse a link destination at the start of s; returns {dest, rest} or null
  if (s.startsWith('<')) {
    const end = s.indexOf('>');
    if (end < 0) return null;
    const dest = s.slice(1, end);
    if (/[\n<>]/.test(dest)) return null;
    return { dest, rest: s.slice(end + 1) };
  }
  const mm = /^[^\s\x00-\x1f()\\]*(?:\\.[^\s\x00-\x1f()\\]*|\([^\s\x00-\x1f()]*\))*/.exec(s);
  const dest = mm ? mm[0] : '';
  if (!dest) return null;
  return { dest, rest: s.slice(dest.length) };
}
function scanTitle(lines, li, text) {
  // Scan a link title starting in `text` (rest of line li after the dest).
  // Returns {title, next} (next = line after the title), {none: true} when
  // there is no title, or null when the definition is malformed.
  // A title on the SAME line as the destination must be well-formed (it may
  // span lines, but never a blank line); a title candidate on the NEXT line
  // that fails to parse just means "no title".
  let s = text.replace(/^[ \t]+/, '');
  let onSameLine = true;
  if (!s) {
    onSameLine = false;
    if (li + 1 >= lines.length || isBlank(lines[li + 1])) return { none: true };
    li = li + 1;
    s = lines[li].replace(/^[ \t]+/, '');
    if (!s || (s[0] !== '"' && s[0] !== "'" && s[0] !== '(')) return { none: true };
  }
  if (!s || (s[0] !== '"' && s[0] !== "'" && s[0] !== '(')) return null;
  const fail = () => (onSameLine ? null : { none: true });
  const open = s[0];
  let out = '', depth = 1;
  let cur = s.slice(1);
  while (true) {
    for (let k = 0; k < cur.length; k++) {
      const c = cur[k];
      if (c === '\\' && k + 1 < cur.length && ASCII_PUNCT(cur[k + 1])) { out += cur[k + 1]; k++; continue; }
      if (open === '(') {
        if (c === '(') { depth++; out += c; }
        else if (c === ')') {
          depth--;
          if (!depth) {
            if (!/^[ \t]*$/.test(cur.slice(k + 1))) return fail();
            return { title: out, next: li + 1 };
          }
          out += c;
        } else out += c;
      } else {
        if (c === open) {
          if (!/^[ \t]*$/.test(cur.slice(k + 1))) return fail();
          return { title: out, next: li + 1 };
        }
        out += c;
      }
    }
    li++;
    if (li >= lines.length || isBlank(lines[li])) return fail();
    out += '\n';
    cur = lines[li];
  }
}
function tryRefDef(lines, i, refs) {
  const line = lines[i];
  const lm = /^ {0,3}\[/.exec(line);
  if (!lm) return null;
  // label: single-line fast path, else scan across lines (labels may span
  // lines and contain balanced brackets; \] does not close).
  let label = null, destLine = i, rest = null, consumed = i + 1;
  const single = /^ {0,3}\[((?:\\.|[^[\]\n])+)\]:[ \t]*(.*)$/.exec(line);
  if (single) {
    label = normLabel(single[1]);
    rest = single[2];
  } else {
    let li = i, ci = lm[0].length, depth = 1, raw = '';
    let found = null;
    while (li < lines.length) {
      const L = lines[li];
      while (ci < L.length) {
        const c = L[ci];
        if (c === '\\' && ci + 1 < L.length) { raw += L.slice(ci, ci + 2); ci += 2; continue; }
        if (c === '[') return null; // labels cannot contain unescaped [
        else if (c === ']') {
          depth--;
          if (!depth) { found = { endLine: li, endCol: ci + 1 }; break; }
        }
        raw += c; ci++;
      }
      if (found) break;
      li++; ci = 0;
      if (li < lines.length) raw += '\n';
    }
    if (!found) return null;
    if (lines[found.endLine][found.endCol] !== ':') return null;
    label = normLabel(raw);
    destLine = found.endLine;
    rest = lines[destLine].slice(found.endCol + 1);
    consumed = destLine + 1;
  }
  if (!label) return null;
  let dest = null, title = null;
  rest = rest.replace(/^[ \t]+/, '');
  if (rest === '') {
    // destination may sit on the next line
    if (consumed >= lines.length || isBlank(lines[consumed])) return null;
    const d = readDest(lines[consumed].replace(/^[ \t]+/, ''));
    if (!d) return null;
    dest = d.dest; rest = d.rest; destLine = consumed; consumed++;
  } else {
    const d = readDest(rest);
    if (!d) return null;
    dest = d.dest; rest = d.rest;
  }
  // a title must be separated from the destination by whitespace
  if (rest !== '' && !/^[ \t]/.test(rest)) return null;
  const t = scanTitle(lines, destLine, rest);
  if (!t) return null;
  if (!t.none) { title = t.title; consumed = t.next; }
  dest = unescapeText(dest);
  if (title !== null) title = unescapeText(title);
  if (!refs.has(label)) refs.set(label, { href: dest, title });
  return { next: consumed };
}

// ---- block-level patterns ----
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/;
const HR_RE = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const BULLET_RE = /^ {0,3}([*+-])([ \t]+|$)/;
const ORDER_RE = /^ {0,3}(\d{1,9})([.)])([ \t]+|$)/;
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

export function parse(src) {
  src = String(src).replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  // ctx holds the link refs (collected during the block pass) and the
  // deferred inline texts; inline rendering runs only after the whole
  // block pass, so forward references resolve (marked resolves a use
  // that appears before its def). istate is the document-level lexer
  // state: an unclosed <a ...> suppresses later bare autolinks.
  const ctx = { refs: new Map(), def: [], endsWithNewline: src.endsWith('\n'), istate: { inLink: false } };
  const html = renderBlocks(lines, 0, lines.length, ctx).blocks.join('');
  return html.replace(/\x00(\d+)\x00/g, (_, id) => inlineParse(ctx.def[+id], ctx.refs, undefined, ctx.istate));
}
function defer(ctx, text) {
  const id = ctx.def.length;
  ctx.def.push(text);
  return '\x00' + id + '\x00';
}
// expand tabs in a leading whitespace run to spaces; the run starts at
// column startCol. Tabs after the run are left alone.
function expandTabsPrefix(line, startCol) {
  let col = startCol, i = 0, out = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; col++; i++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
  }
  return out + line.slice(i);
}

function renderBlocks(lines, a, b, ctx, noSetext, atDocEnd = true, trailingSpaceOk = false, lazyLines = null, inItem = false, taskStrip = false, endsNL = ctx.endsWithNewline) {
  const refs = ctx.refs;
  const out = [];
  let loose = false;
  let taskStripped = false;
  let pendingBlank = false;
  const emit = (html) => { if (pendingBlank) { loose = true; pendingBlank = false; } out.push(html); };
  let i = a;
  while (i < b) {
    const line = lines[i];
    if (isBlank(line)) { if (out.length) pendingBlank = true; i++; continue; }
    const info = indentInfo(line);
    // First non-whitespace char: block dispatch is gated on it, so most
    // lines run one cheap comparison instead of a dozen regexes.
    const fc = line[info.idx] ?? '';

    // indented code (only at block start, indent >= 4)
    if (info.col >= 4) {
      const buf = [];
      let j = i;
      while (j < b) {
        const L = lines[j];
        if (isBlank(L)) {
          let k = j + 1;
          while (k < b && isBlank(lines[k])) k++;
          if (k < b && indentInfo(lines[k]).col >= 4) { buf.push(stripCols(L, 4)); j++; continue; }
          break;
        }
        if (indentInfo(L).col >= 4) { buf.push(stripCols(L, 4)); j++; }
        else break;
      }
      while (buf.length && buf[buf.length - 1] === '') buf.pop();
      emit('<pre><code>' + escapeCode(buf.join('\n')) + '\n</code></pre>\n');
      i = j;
      continue;
    }

    // ATX heading
    let m = null;
    if (fc === '#') m = ATX_RE.exec(line);
    if (m) {
      let text = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (/^#+$/.test(text)) text = '';
      else text = text.replace(/[ \t]+#+[ \t]*$/, '');
      emit('<h' + m[1].length + '>' + defer(ctx, text) + '</h' + m[1].length + '>\n');
      i++;
      continue;
    }

    // fenced code
    m = null;
    if (fc === '`' || fc === '~') m = FENCE_RE.exec(line);
    if (m) {
      const fence = m[1], ch = fence[0];
      let infoStr = m[2];
      if (ch === '`' && infoStr.includes('`')) { /* not a fence; fall through */ }
      else {
        infoStr = infoStr.trim();
        const lang = unescapeText(infoStr.split(/[ \t]+/)[0] || '');
        const fenceIndent = info.col;
        const buf = [];
        let j = i + 1;
        while (j < b) {
          const L = lines[j];
          const fm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(L);
          if (fm && fm[1][0] === ch && fm[1].length >= fence.length) { j++; break; }
          // tilde fences keep content indentation verbatim (marked Dt);
          // backtick fences strip by character count (stripFence).
          buf.push(ch === '~' ? L : stripFence(L, fenceIndent));
          j++;
        }
        if (buf.length && buf[buf.length - 1] === '') buf.pop();
        const cls = lang ? ' class="language-' + escapeAttr(lang) + '"' : '';
        emit('<pre><code' + cls + '>' + escapeCode(buf.join('\n')) + (buf.length ? '\n' : '') + '</code></pre>\n');
        i = j;
        continue;
      }
    }

    // thematic break
    if ((fc === '*' || fc === '-' || fc === '_') && HR_RE.test(line)) { emit('<hr>\n'); i++; continue; }

    // HTML block
    const hb = fc === '<' ? htmlBlock(lines, i, b) : null;
    if (hb) {
      // Trailing-newline rules, verified against marked (they differ by
      // type). Types 1-5: the block keeps the newline after its last
      // line iff the container source has a '\n' there and the char
      // after it is not another '\n' — i.e. a '\n' follows the block
      // (a next line exists, or the container source ends with one)
      // and the next line is not empty-with-more-after-it. Types 6-7:
      // the block keeps it only when it is the last non-blank block of
      // its container and the container source ends with exactly one
      // '\n' (a blockquote chunk ending in an empty quote line and a
      // list item followed by a blank line before the next item both
      // count as ending with one; a tight list item, and a top-level
      // block followed by a blank line, do not).
      let keepNL;
      if (hb.type <= 5) {
        const hasNLAfter = hb.next < b || endsNL;
        const nextIsEmptyNL = hb.next < b && lines[hb.next] === '' && (hb.next + 1 < b || endsNL);
        keepNL = hasNLAfter && !nextIsEmptyNL;
      } else {
        const restBlank = lines.slice(hb.next, b).every(isBlank);
        const lastLine = b > 0 ? lines[b - 1] : '';
        const exactlyOneNL = (lastLine === '' && !endsNL) || (lastLine !== '' && endsNL);
        keepNL = restBlank && exactlyOneNL;
      }
      emit(hb.html + (keepNL ? '\n' : ''));
      i = hb.next;
      continue;
    }

    // blockquote
    if (fc === '>' && /^ {0,3}>/.test(line)) {
      const chunk = [];
      const noSetext = new Set();
      const lazyLines = new Set();
      let lazyRun = 0;
      let hasDelim = false;
      const TABLE_DELIM_RE = /^ {0,3}\|?([ \t]*:?-{1,}:?[ \t]*\|?)+[ \t]*$/;
      const isBlockOpener = (L) => {
        if (ATX_RE.test(L) || HR_RE.test(L) || indentInfo(L).col >= 4) return true;
        const fm = FENCE_RE.exec(L);
        if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) return true;
        const t = htmlBlockType(L);
        if (t >= 1 && t <= 6) return true;
        if (TABLE_DELIM_RE.test(L)) return true;
        if (L.includes('|') && hasDelim) return true;
        return false;
      };
      let fence = null;
      let j = i;
      while (j < b) {
        const L = lines[j];
        if (/^ {0,3}>/.test(L)) {
          const qm = /^ {0,3}>/.exec(L);
          const after = L.slice(qm[0].length);
          const expanded = expandTabsPrefix(after, qm[0].length);
          const content = expanded.charAt(0) === ' ' ? stripCols(expanded, 1) : expanded;
          if (TABLE_DELIM_RE.test(content)) hasDelim = true;
          if (fence) {
            const fm2 = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content);
            if (fm2 && fm2[1][0] === fence.ch && fm2[1].length >= fence.len) fence = null;
          } else {
            const fm2 = FENCE_RE.exec(content);
            if (fm2 && !(fm2[1][0] === '`' && fm2[2].includes('`'))) fence = { ch: fm2[1][0], len: fm2[1].length };
          }
          chunk.push(content);
          lazyRun = 0;
          j++;
        } else if (isBlank(L)) {
          // a blank line without > ends the blockquote
          break;
        } else if (chunk.length && chunk[chunk.length - 1] !== '' && !interruptsPara(L)) {
          // lazy continuation: only while the quote's last block is a
          // paragraph (a fence, heading, table, html block or indented
          // code closes lazy continuation off).
          let last = '';
          for (let k = chunk.length - 1; k >= 0; k--) {
            if (chunk[k] !== '') { last = chunk[k]; break; }
          }
          if (fence || !last || isBlockOpener(last)) break;
          // a setext-looking lazy line stays paragraph text: 2nd+ in a
          // lazy run is indented 4 spaces, the 1st is kept as-is but
          // shielded from becoming a setext underline.
          const stripped = indentInfo(L).col >= 4 ? stripCols(L, 4) : L;
          if (SETEXT_RE.test(stripped)) {
            if (lazyRun >= 1 && indentInfo(L).col < 4) chunk.push('    ' + L);
            else { noSetext.add(chunk.length); chunk.push(stripped); }
          } else chunk.push(stripped);
          lazyLines.add(chunk.length - 1);
          lazyRun++;
          j++;
        } else break;
      }
      const inner = renderBlocks(chunk, 0, chunk.length, ctx, noSetext, atDocEnd && j === b, true, lazyLines, false, false, false);
      emit('<blockquote>\n' + inner.blocks.join('') + '</blockquote>\n');
      i = j;
      continue;
    }


    // list
    const lst = (fc === '*' || fc === '+' || fc === '-' || (fc >= '0' && fc <= '9')) ? tryList(lines, i, b, ctx, atDocEnd) : null;
    if (lst) { emit(lst.html); i = lst.next; continue; }

    // table (header line + delimiter row)
    if (i + 1 < b && line.includes('|')) {
      const tbl = tryTable(lines, i, b, ctx);
      if (tbl) { emit(tbl.html); i = tbl.next; continue; }
    }

    // paragraph (with setext heading + link ref defs)
    let j = i;
    const para = [];
    let headingLevel = 0;
    while (j < b) {
      const L = lines[j];
      if (isBlank(L)) {
        // inside a blockquote, a trailing spaces-only line joins the
        // paragraph instead of ending it.
        if (trailingSpaceOk && para.length > 0 && j === b - 1 && L !== '') { para.push(L); j++; }
        break;
      }
      if (para.length === 0) {
        const rd = tryRefDef(lines, j, refs);
        if (rd) { if (pendingBlank) { loose = true; pendingBlank = false; } j = rd.next; continue; }
        if (j > i) {
          // a paragraph cannot start here once refdefs were consumed
          if (startsBlock(L)) break;
          if (L.includes('|') && j + 1 < b && tryTable(lines, j, b, ctx)) break;
        }
      }
      if (para.length > 0 && !(lazyLines && lazyLines.has(j))) {
        const sm = SETEXT_RE.exec(L);
        if (sm && !(noSetext && noSetext.has(j))) { headingLevel = sm[1][0] === '=' ? 1 : 2; j++; break; }
        if (interruptsPara(L, inItem)) break;
      }
      para.push(L);
      j++;
    }
    if (headingLevel) {
      const content = para.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      emit('<h' + headingLevel + '>' + defer(ctx, content) + '</h' + headingLevel + '>\n');
    } else if (para.length) {
      let text = para.join('\n');
      // task checkbox: strip '[x] ' from the first paragraph's raw text
      // (before inline rendering, so it can never become a link/heading).
      if (taskStrip && !taskStripped && out.length === 0) {
        const tm = /^\[[ xX]\][ \t]+/.exec(text);
        if (tm) { text = text.slice(tm[0].length); taskStripped = true; }
      }
      emit('<p>' + defer(ctx, text) + '</p>\n');
    }
    i = j;
  }
  return { blocks: out, loose, taskStripped };
}

function interruptsPara(line, inItem) {
  // First-char dispatch: each test below is only reachable from lines
  // whose first non-whitespace char can start that construct.
  const ii = indentInfo(line);
  const fc = line[ii.idx] ?? '';
  if (fc === '#') { if (ATX_RE.test(line)) return true; }
  if (fc === '`' || fc === '~') {
    const fm = FENCE_RE.exec(line);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) return true;
  }
  if (fc === '*' || fc === '-' || fc === '_') { if (HR_RE.test(line)) return true; }
  if (fc === '>' && /^ {0,3}>/.test(line)) return true;
  if (fc === '<') {
    const t = htmlBlockType(line);
    if (t >= 1 && t <= 6) return true;
  }
  if (fc === '*' || fc === '+' || fc === '-') {
    const bm = BULLET_RE.exec(line);
    if (bm) {
      // an empty list item cannot interrupt a paragraph
      const after = line.slice(leadWs(line) + bm[1].length);
      if (after.trim() !== '') return true;
      return false;
    }
  }
  if (fc >= '0' && fc <= '9') {
    const om = ORDER_RE.exec(line);
    if (om && (inItem || +om[1] === 1)) {
      const after = line.slice(leadWs(line) + om[1].length + 1);
      if (after.trim() !== '') return true;
      return false;
    }
  }
  return false;
}
function startsBlock(line) {
  if (interruptsPara(line)) return true;
  const ii = indentInfo(line);
  const fc = line[ii.idx] ?? '';
  if (fc >= '0' && fc <= '9' && ORDER_RE.test(line)) return true;
  return ii.col >= 4;
}

// ---- HTML blocks (types 1-7) ----
function htmlBlockType(line) {
  const s = line.replace(/^ {0,3}/, '');
  if (/^<(pre|script|style|textarea)(\s|>|$)/i.test(s)) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(s)) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/.exec(s);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  if (/^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/.test(s)) {
    const nm = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s)[1].toLowerCase();
    if (!/^(pre|script|style|textarea)$/.test(nm)) return 7;
  }
  return 0;
}
function htmlBlock(lines, i, b) {
  const type = htmlBlockType(lines[i]);
  if (!type) return null;
  const buf = [];
  let j = i;
  const enders = { 1: /<\/(pre|script|style|textarea)>/i, 2: /-->/, 3: /\?>/, 4: />/, 5: /\]\]>/ };
  if (type >= 1 && type <= 5) {
    const re = enders[type];
    while (j < b) {
      buf.push(lines[j]);
      if (re.test(lines[j])) { j++; break; }
      j++;
    }
  } else {
    while (j < b && !isBlank(lines[j])) { buf.push(lines[j]); j++; }
  }
  return { html: buf.join('\n'), next: j, type };
}

// ---- lists ----
function listMarker(line) {
  let m = BULLET_RE.exec(line);
  if (m) return { kind: 'bullet', marker: m[1], after: m[2], indent: indentInfo(line).col };
  m = ORDER_RE.exec(line);
  if (m) return { kind: 'ordered', marker: m[1] + m[2], start: +m[1], delim: m[2], after: m[2] === '' ? '' : m[3], indent: indentInfo(line).col };
  return null;
}
function markerContentIndent(line, mk) {
  // columns consumed by marker + following spaces (1..4); 5+ spaces -> marker + 1
  const lead = leadWs(line);
  const col = indentInfo(line).col + mk.marker.length;
  let p = lead + mk.marker.length;
  let spaces = 0;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) {
    if (line[p] === ' ') { spaces++; p++; }
    else { const w = 4 - ((col + spaces) % 4); spaces += w; p++; }
  }
  if (spaces === 0) return { contentIndent: col + 1, firstLine: '' };
  // expand the separator tabs to spaces (column-based), then drop the
  // content indent from the expanded prefix; content tabs stay literal.
  let expanded = '', c = 0;
  for (const ch of line.slice(0, p)) {
    if (ch === '\t') { const w = 4 - (c % 4); expanded += ' '.repeat(w); c += w; }
    else { expanded += ch; c++; }
  }
  const rest = line.slice(p);
  if (rest.trim() === '') return { contentIndent: col + 1, firstLine: '' };
  if (spaces >= 5) return { contentIndent: col + 1, firstLine: expanded.slice(col + 1) + rest };
  return { contentIndent: col + spaces, firstLine: expanded.slice(col + spaces) + rest };
}
function tryList(lines, i, b, ctx, atDocEnd = true) {
  const refs = ctx.refs;
  const first = listMarker(lines[i]);
  if (!first) return null;
  const items = [];
  let j = i;
  let loose = false;
  let cur = null;
  const pushItem = () => { if (cur) items.push(cur); };
  // Lazy continuation is only legal while the item's last block is a
  // paragraph (same rule as the blockquote's lazy branch, and as
  // marked's list loop, which breaks when the previous line starts a
  // fence/heading/html/hr or is indented 4+). Note the test is on the
  // previous line only: a fence's CONTENT lines do not close lazy
  // continuation off — an unindented line after fence content is
  // itself fence content (doc-06) — only the fence OPENER line does.
  const TABLE_DELIM_RE = /^ {0,3}\|?([ \t]*:?-{1,}:?[ \t]*\|?)+[ \t]*$/;
  const isBlockOpener = (L, hasDelim) => {
    if (ATX_RE.test(L) || HR_RE.test(L) || indentInfo(L).col >= 4) return true;
    const fm = FENCE_RE.exec(L);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) return true;
    const t = htmlBlockType(L);
    if (t >= 1 && t <= 6) return true;
    if (TABLE_DELIM_RE.test(L)) return true;
    if (L.includes('|') && hasDelim) return true;
    if (listMarker(L)) return true;
    return false;
  };
  const trackContentLine = (content) => {
    if (TABLE_DELIM_RE.test(content)) cur.hasDelim = true;
  };
  const sameListMarker = (mk, ind) => {
    if (!mk || mk.kind !== first.kind) return false;
    if (first.kind === 'bullet' ? mk.marker !== first.marker : mk.delim !== first.delim) return false;
    // sibling items may sit up to 3 columns past the first item's indent,
    // but never at or past the current item's content indent (that is a
    // nested list).
    return ind <= first.indent + 3 && (!cur || ind < cur.indent);
  };
  while (j < b) {
    const L = lines[j];
    const ind = indentInfo(L).col;
    const mk = listMarker(L);
    // a thematic break beats a new list item, but not an item continuation
    if (cur && HR_RE.test(L) && ind < cur.indent) break;
    if (sameListMarker(mk, ind)) {
      pushItem();
      const ci = markerContentIndent(L, mk);
      cur = { lines: ci.firstLine === '' && isBlank(L.slice(leadWs(L) + mk.marker.length)) ? [] : [ci.firstLine], indent: ci.contentIndent, lazySetext: new Set(), endsWithNL: false, hasDelim: false };
      if (cur.lines.length) trackContentLine(cur.lines[0]);
      j++;
      continue;
    }
    if (!cur) break;
    if (isBlank(L)) {
      let k = j + 1;
      while (k < b && isBlank(lines[k])) k++;
      if (k < b) {
        const KL = lines[k];
        const kInd = indentInfo(KL).col;
        const kmk = listMarker(KL);
        if (sameListMarker(kmk, kInd)) {
          loose = true; // blank between items
          // The blank line(s) before the next item make this item's
          // source end with a newline (its html blocks keep the '\n').
          cur.endsWithNL = true;
          j = k; // skip blanks, next loop starts a new item
          continue;
        }
        // a blank line ends an item that has no content yet
        if (cur.lines.length === 0) break;
        if (kInd >= cur.indent) {
          cur.lines.push('');
          j++;
          continue;
        }
      }
      break;
    }
    if (ind >= cur.indent) {
      const stripped = stripCols(expandTabsPrefix(L, 0), cur.indent);
      cur.lines.push(stripped);
      trackContentLine(stripped);
      j++;
      continue;
    }
    // lazy paragraph continuation inside the item; a setext-looking
    // lazy line stays paragraph text (it is not a proper content line).
    // Indented code cannot interrupt a paragraph, so a 4+-indented line
    // may still be lazy text here. Lazy continuation is only legal
    // while the item's last block is a paragraph: a line after a
    // fence (e.g. the fence opener is in the item but its content
    // lines are not) ends the item instead.
    if (cur.lines.length && cur.lines[cur.lines.length - 1] !== '' && !interruptsPara(L) && !listMarker(L)) {
      let last = '';
      for (let k = cur.lines.length - 1; k >= 0; k--) { if (cur.lines[k] !== '') { last = cur.lines[k]; break; } }
      if (!last || isBlockOpener(last, cur.hasDelim)) break;
      const stripped = indentInfo(L).col >= 4 ? stripCols(L, 4) : L;
      cur.lazySetext.add(cur.lines.length);
      cur.lines.push(stripped);
      trackContentLine(stripped);
      j++;
      continue;
    }
    break;
  }
  pushItem();
  if (!items.length) return null;
  const tag = first.kind === 'bullet' ? 'ul' : 'ol';
  let attr = '';
  if (first.kind === 'ordered' && first.start !== 1) attr = ' start="' + first.start + '"';
  const listEndsAtDocEnd = atDocEnd && j === b;
  const rendered = [];
  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii];
    const contentLines = it.lines;
    while (contentLines.length && isBlank(contentLines[contentLines.length - 1])) contentLines.pop();
    const isTask = contentLines.length > 0 && /^\[[ xX]\][ \t]+\S/.test(contentLines[0]);
    const r = renderBlocks(contentLines, 0, contentLines.length, ctx, it.lazySetext, listEndsAtDocEnd && ii === items.length - 1, false, it.lazySetext, true, isTask, !!it.endsWithNL);
    if (r.loose) loose = true;
    // task checkbox: marked lexes the item WITH '[x] ' in place (so
    // '[x] # head' is a paragraph, not a heading), then extracts the
    // checkbox from the first paragraph only.
    let check = '';
    if (r.taskStripped) {
      const cm = /^\[([ xX])\]/.exec(contentLines[0]);
      check = '<input' + (cm[1] === ' ' ? '' : ' checked=""') + ' disabled="" type="checkbox"> ';
    }
    rendered.push({ check, blocks: r.blocks });
  }
  let html = '<' + tag + attr + '>\n';
  for (const { check, blocks } of rendered) {
    let inner;
    let pre = check;
    if (!loose) {
      inner = blocks.map((blk) => blk.startsWith('<p>') ? blk.slice(3, -5) : blk).join('');
    } else {
      // loose: the checkbox goes INSIDE the first <p>
      if (check && blocks.length && blocks[0].startsWith('<p>')) {
        blocks[0] = '<p>' + check + blocks[0].slice(3);
        pre = '';
      }
      inner = blocks.join('');
    }
    if (!inner) inner = '';
    html += '<li>' + pre + inner + '</li>\n';
  }
  html += '</' + tag + '>\n';
  return { html, next: j };
}


// ---- GFM tables ----
function splitRow(line) {
  // split on unescaped | outside code spans
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { if (s[i + 1] === '|') cur += '|'; else cur += s.slice(i, i + 2); i += 2; }
    else if (c === '|') { cells.push(cur); cur = ''; i++; }
    else { cur += c; i++; }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}
function tryTable(lines, i, b, ctx) {
  const refs = ctx.refs;
  const delim = lines[i + 1];
  if (!/^ {0,3}\|?([ \t]*:?-{1,}:?[ \t]*\|?)+[ \t]*$/.test(delim)) return null;
  const dCells = splitRow(delim);
  const aligns = [];
  let ok = true;
  for (const c of dCells) {
    const t = c.trim();
    if (/^:-+$/.test(t)) aligns.push('left');
    else if (/^-+:$/.test(t)) aligns.push('right');
    else if (/^:-+:$/.test(t)) aligns.push('center');
    else if (/^-+$/.test(t)) aligns.push(null);
    else { ok = false; break; }
  }
  if (!ok || !aligns.length) return null;
  const head = splitRow(lines[i]);
  if (head.length !== aligns.length) return null;
  let html = '<table>\n<thead>\n<tr>\n';
  for (let k = 0; k < aligns.length; k++) {
    const cell = head[k] ?? '';
    html += '<th' + (aligns[k] ? ' align="' + aligns[k] + '"' : '') + '>' + defer(ctx, cell) + '</th>\n';
  }
  html += '</tr>\n</thead>\n';
  const rows = [];
  let j = i + 2;
  while (j < b && !/^ *$/.test(lines[j]) && (/^[ \t]*$/.test(lines[j]) || !startsBlock(lines[j]))) {
    rows.push(splitRow(lines[j]));
    j++;
  }
  // A trailing whitespace-only row is stripped only when it is the last
  // line of the input with no newline after it (marked's tableRowBlankLine
  // is /\n[ \t]*$/); a tab-only row mid-table (e.g. followed by a list)
  // is a real empty row, not a blank line.
  if (rows.length && /^[ \t]*$/.test(lines[j - 1]) && j === b && b === lines.length && !ctx.endsWithNewline) { rows.pop(); j--; }
  if (rows.length) {
    html += '<tbody>';
    for (const row of rows) {
      html += '<tr>\n';
      for (let k = 0; k < aligns.length; k++) {
        const cell = row[k] ?? '';
        html += '<td' + (aligns[k] ? ' align="' + aligns[k] + '"' : '') + '>' + defer(ctx, cell) + '</td>\n';
      }
      html += '</tr>\n';
    }
    html += '</tbody>';
  }
  html += '</table>\n';
  return { html, next: j };
}

// ---- inline parsing ----
function cleanUrl(href) {
  try { return encodeURI(href.trim()).replace(/%25/g, '%'); }
  catch (e) { return href.trim(); }
}

function findCodeClose(src, from, n) {
  // a closing code-span run must have exactly n backticks
  let i = from;
  while (i < src.length) {
    if (src[i] === '`') {
      let r = 0;
      while (i + r < src.length && src[i + r] === '`') r++;
      if (r === n) return i;
      i += r;
    } else i++;
  }
  return -1;
}
const INLINE_HTML_RE = /^(?:<!-->|<!--->|<!--[\s\S]*?-->|<\?(?:[^?]|\?[^>])*?\?>|<!\[CDATA\[(?:[^\]]|\][^\]]|\]\][^>])*?\]\]>|<![A-Za-z][^>]*>|<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)/;
function findLinkEnd(src, open) {
  // src[open] === '['; find the ']' closing the label, honoring nesting,
  // escapes, code spans and <...> tags/autolinks (a ']' inside one of
  // those never closes the label — cm-524/526/536/538).
  let depth = 0, i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (c === '`') {
      let n = 0;
      while (i + n < src.length && src[i + n] === '`') n++;
      // A run of 2+ backticks immediately before ']' is a label token
      // on its own (marked's `` ``+(?=\]) ``) — the lazy label ends
      // here, so a code-span parse must NOT reach past the ']' to a
      // later backtick run (that is what broke doc-33 in the full doc).
      if (n >= 2 && src[i + n] === ']') { i += n; continue; }
      // Otherwise a code span: the next backtick run of any length
      // closes it (an escaped backtick still counts as a run of 1).
      // With no later run the span is unclosed and the label cannot
      // close at all.
      let q = i + n, found = -1, m = 0;
      while (q < src.length) {
        if (src[q] === '`') { let r2 = q; while (r2 < src.length && src[r2] === '`') r2++; m = r2 - q; found = q; break; }
        q++;
      }
      if (found < 0) return -1;
      i = found + m;
      continue;
    }
    if (c === '<') {
      const hm = INLINE_HTML_RE.exec(src.slice(i));
      if (hm) { i += hm[0].length; continue; }
      const am = AUTOLINK_RE.exec(src.slice(i + 1));
      if (am) { i += 1 + am[0].length; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (!depth) return i; }
    i++;
  }
  return -1;
}
function parseInlineDest(s, i) {
  // s[i] === '('; returns {href, title, end} (end = index after ')') or null
  let j = i + 1;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  let href = '';
  if (s[j] === '<') {
    let e = j + 1, bad = false;
    while (e < s.length) {
      const ch = s[e];
      if (ch === '\\' && e + 1 < s.length) { e += 2; continue; }
      if (ch === '<' || ch === '\n') { bad = true; break; }
      if (ch === '>') break;
      e++;
    }
    if (bad || e >= s.length || s[e] !== '>') return null;
    href = s.slice(j + 1, e);
    j = e + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length) { j += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (!depth) break; depth--; }
      else if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      j++;
    }
    href = s.slice(start, j);
  }
  let hadWs = false;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; hadWs = true; }
  let title = null;
  if (s[j] === '"' || s[j] === "'" || s[j] === '(') {
    if (!hadWs) return null; // title must be separated from the dest by whitespace
    const t = parseTitle(s.slice(j));
    if (!t) return null;
    title = t.title;
    j += s.slice(j).length - t.rest.length;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  }
  if (s[j] !== ')') return null;
  return { href: unescapeText(href), title: title === null ? null : unescapeText(title), end: j + 1 };
}
function tryLink(src, i, refs, isImage, istate) {
  // src[i] === '[' (image: src[i-1] === '!'). istate is the shared
  // document-level lexer state, threaded into nested inline renders so
  // an unclosed <a> inside a link label still suppresses autolinks.
  // Returns {node, end} or null.
  const close = findLinkEnd(src, i);
  if (close < 0) return null;
  const inner = src.slice(i + 1, close);
  let after = close + 1;
  let href = null, title = null;
  if (src[after] === '(') {
    const d = parseInlineDest(src, after);
    if (d) { href = d.href; title = d.title; after = d.end; }
  }
  if (href === null) {
    if (src[after] === '[') {
    // reference label: first unescaped ] (escapes don't close it);
    // marked's ref grammar allows no nested '[' inside the ref.
    let e = -1;
    for (let k = after + 1; k < src.length; k++) {
      if (src[k] === '\\' && k + 1 < src.length) { k++; continue; }
      if (src[k] === '[') return null;
      if (src[k] === ']') { e = k; break; }
    }
    if (e < 0) return null;
    const label = e === after + 1 ? normLabel(inner) : normLabel(src.slice(after + 1, e));
    const ref = refs.get(label);
    if (!ref) return null;
      href = ref.href; title = ref.title; after = e + 1;
    } else {
      const ref = refs.get(normLabel(inner));
      if (!ref) return null;
      href = ref.href; title = ref.title;
    }
  }
  const clean = cleanUrl(href);
  if (clean === null) return null;
  if (isImage) {
    const alt = stripTags(renderNodes(tokenizeInline(inner, refs, false, false, istate)));
    return { node: { k: 'img', href: clean, title, alt }, end: after };
  }
  const innerNodes = tokenizeInline(inner, refs, false, true, istate);
  if (hasLink(innerNodes)) return null; // a link cannot contain a link
  return { node: { k: 'link', href: clean, title, inner: renderNodes(innerNodes) }, end: after };
}
function stripTags(html) {
  return html.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, (_, alt) => alt.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')).replace(/<[^>]*>/g, '');
}

const AUTOLINK_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)>/;
const SCHEME_RE = /^(?:https?|ftp):\/\/[^\s<]+/i;
const WWW_RE = /^www\.[^\s<]+/i;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/;
// Word-char scan used to bound autolink/email attempts: the end of the
// run of chars that can appear in a bare email starting at i (exactly
// the EMAIL_RE charset: local part + '@' + domain). The regex match can
// never extend past this run, so a slice to here matches exactly what
// the regex would match on the whole remainder. One pass returns the
// end, or -1 when the run holds no '@' (then no email can match).
// A 128-entry lookup table keeps the per-char test to one array read.
const EMAIL_CHARS = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~@-") EMAIL_CHARS[ch.charCodeAt(0)] = 1;
function wordEndWithAt(s, i) {
  let j = i, hasAt = false;
  while (j < s.length) {
    const code = s.charCodeAt(j);
    if (code >= 128 || !EMAIL_CHARS[code]) break;
    if (code === 64) hasAt = true;
    j++;
  }
  return hasAt ? j : -1;
}
// Scan a bare-URL end: first whitespace or '<' at/after i.
function urlEnd(s, i) {
  let j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '<') break;
    j++;
  }
  return j;
}
// Does the rest of the string at i start with http://, https:// or
// ftp:// (any case)? Manual char tests, no allocation. Returns the
// scheme length (7/8/6) or 0.
function schemeLen(s, i) {
  const c0 = s[i];
  if (c0 === 'h' || c0 === 'H') {
    if ((s[i + 1] === 't' || s[i + 1] === 'T') && (s[i + 2] === 't' || s[i + 2] === 'T') && (s[i + 3] === 'p' || s[i + 3] === 'P')) {
      if (s[i + 4] === ':' && s[i + 5] === '/' && s[i + 6] === '/') return 7;
      if ((s[i + 4] === 's' || s[i + 4] === 'S') && s[i + 5] === ':' && s[i + 6] === '/' && s[i + 7] === '/') return 8;
    }
    return 0;
  }
  if (c0 === 'f' || c0 === 'F') {
    if ((s[i + 1] === 't' || s[i + 1] === 'T') && (s[i + 2] === 'p' || s[i + 2] === 'P') && s[i + 3] === ':' && s[i + 4] === '/' && s[i + 5] === '/') return 6;
  }
  return 0;
}
function emailTailOk(src, end, nodes) {
  const c = src[end];
  if (c === '-') return false;
  if (c === '_') {
    // '_' is fine when it closes an emphasis (a prior '_' opener exists)
    for (let k = nodes.length - 1; k >= 0; k--) {
      const nd = nodes[k];
      if (nd.k === 'd' && nd.ch === '_' && nd.co) return true;
    }
    return false;
  }
  return true;
}
function trimUrlTail(u) {
  // url backpedal, applied until stable: the longest prefix made of
  // safe runs, balanced (...) groups, a non-entity '&', and
  // punctuation runs that do not reach the end of the string.
  const P = '?!.,:;*_\'"~)';   // punctuation-run chars
  const X = '?!.,:;*_\'"~()&'; // chars excluded from safe runs
  let cur = u;
  for (;;) {
    let i = 0, end = 0;
    const n = cur.length;
    while (i < n) {
      const c = cur[i];
      if (c === '(') {
        let j = i + 1;
        while (j < n && cur[j] !== ')') j++;
        if (j >= n) break; // no closer: url ends before '('
        i = j + 1; end = i; continue;
      }
      if (c === '&') {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9]/.test(cur[j])) j++;
        if (j > i + 1 && j < n && cur[j] === ';' && j === n - 1) break;
        i++; end = i; continue;
      }
      if (!X.includes(c)) {
        while (i < n && !X.includes(cur[i])) i++;
        end = i; continue;
      }
      if (P.includes(c)) {
        let j = i;
        while (j < n && P.includes(cur[j])) j++;
        if (j === n) break; // punct run reaches the end: stop before it
        i = j; end = i; continue;
      }
      break;
    }
    const next = cur.slice(0, end);
    if (next === cur) return cur;
    cur = next;
  }
}

// ---- emphasis masking (marked's blockSkip, re-typed under this recording) ----
// Marked scans emphasis over a masked copy of the inline text: code spans,
// link-like spans and HTML tags become same-length `[aaa...]` placeholders,
// so a delimiter inside one of them is invisible to the emphasis scan.
// E.g. `` ``small` `` in a label pairs with a later lone backtick, hiding
// everything between them (including a `__...__`) from the closer scan.
// Two passes, as in marked: (1) normalize — inner backticks of a real code
// span become `+`, and backslash-escaped punctuation becomes `++`; (2) the
// blockSkip pass replaces each link-like span, code span or HTML tag with a
// same-length placeholder. computeMask returns a Uint8Array, 1 = masked.
// The scanners in this file are original implementations of the same rules.
function otNormalize(s) {
  // Fast paths: no backtick means only backslash-escaped punctuation
  // matters (one C-level regex replace); nothing at all means identity.
  if (!s.includes('`')) {
    if (!s.includes('\\')) return s;
    return s.replace(/\\[\p{P}\p{S}]/gu, '++');
  }
  // Backtick path: jump (indexOf, C-level) between backtick runs and
  // backslashes instead of walking every char. Plain stretches stay in
  // one pending chunk; only a matched code span's inner backticks are
  // rewritten (one replace over the span content), and a backslash
  // before punctuation becomes '++'. Semantics identical to the
  // char-by-char version: backslashes inside code spans are untouched.
  const n = s.length;
  const chunks = [];
  let i = 0, last = 0;
  const pushUpTo = (end) => { if (end > last) chunks.push(s.slice(last, end)); };
  while (i < n) {
    const bt = s.indexOf('`', i);
    const bs = s.indexOf('\\', i);
    if (bt < 0 && bs < 0) break;
    if (bs >= 0 && (bt < 0 || bs < bt)) {
      if (bs + 1 < n && isPunct(s[bs + 1])) {
        pushUpTo(bs); chunks.push('++');
        i = bs + 2; last = i;
      } else {
        i = bs + 1;
      }
      continue;
    }
    let b = 0; while (bt + b < n && s[bt + b] === '`') b++;
    let k = bt + b, end = -1;
    while (k < n) {
      if (s[k] === '`') {
        let b2 = 0; while (k + b2 < n && s[k + b2] === '`') b2++;
        if (b2 === b && k > bt + b) { end = k + b2; break; }
        k += b2;
      } else k++;
    }
    if (end > 0) {
      pushUpTo(bt + b);
      const inner = s.slice(bt + b, end - b);
      chunks.push(inner.includes('`') ? inner.replace(/`/g, '+') : inner);
      last = end - b; i = end;
    } else {
      i = bt + b;
    }
  }
  pushUpTo(n);
  return chunks.length === 1 ? chunks[0] : chunks.join('');
}
// s[i] === '['; returns the exclusive end of a `[label](dest)` span or -1.
// The label may contain balanced backtick runs but no raw `[`; the dest
// allows escapes and one level of paren groups.
function matchLinkLike(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '`') {
      let b = 0; while (j + b < n && s[j + b] === '`') b++;
      let k = j + b;
      if (k >= n || s[k] === '`') return -1;
      while (k < n && s[k] !== '`') k++;
      if (k >= n) return -1;
      let b2 = 0; while (k + b2 < n && s[k + b2] === '`') b2++;
      if (b2 !== b) return -1;
      if (k + b2 < n && s[k + b2] === '`') return -1;
      j = k + b2;
      continue;
    }
    if (c === '[') return -1;
    if (c === ']') {
      if (s[j + 1] !== '(') return -1;
      let k = j + 2;
      while (k < n) {
        const d = s[k];
        if (d === '\\') { k += 2; continue; }
        if (d === ')') return k + 1;
        if (d === '(') {
          let q = k + 1;
          while (q < n) {
            const e2 = s[q];
            if (e2 === '\\') { q += 2; continue; }
            if (e2 === '(') return -1;
            if (e2 === ')') break;
            q++;
          }
          if (q >= n) return -1;
          k = q + 1;
          continue;
        }
        k++;
      }
      return -1;
    }
    j++;
  }
  return -1;
}
// A code span match starting at i: at string start the backtick run is
// direct; elsewhere one leading non-backtick char. Returns {end, b} or null.
function matchPrecode(s, i) {
  const n = s.length;
  let start;
  if (i === 0) start = 0;
  else {
    if (s[i] === '`') return null;
    start = i + 1;
  }
  if (start >= n || s[start] !== '`') return null;
  let b = 0; while (start + b < n && s[start + b] === '`') b++;
  let k = start + b;
  if (k >= n || s[k] === '`') return null;
  while (k < n && s[k] !== '`') k++;
  if (k >= n) return null;
  let b2 = 0; while (k + b2 < n && s[k + b2] === '`') b2++;
  if (b2 !== b) return null;
  if (k + b2 < n && s[k + b2] === '`') return null;
  return { end: k + b2, b };
}
// s[i] === '<', next char not a space; up to the next '>' with no '<'.
function matchHtmlTag(s, i) {
  const n = s.length;
  if (i + 1 >= n || s[i + 1] === ' ') return -1;
  let j = i + 1;
  while (j < n) {
    if (s[j] === '<') return -1;
    if (s[j] === '>') return j + 1;
    j++;
  }
  return -1;
}
function computeMask(s) {
  const t = otNormalize(s);
  const n = t.length;
  const masked = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    // Jump to the next position where a span could start: a '[', a '<',
    // or the char just before a backtick run (a code span may start at
    // 0 or at the char before its opening run). Plain stretches between
    // candidates hold no span start, so skipping them is exact.
    const bq = t.indexOf('`', i);
    let next = n;
    const br = t.indexOf('[', i);
    if (br >= 0 && br < next) next = br;
    const lt = t.indexOf('<', i);
    if (lt >= 0 && lt < next) next = lt;
    if (bq >= 0 && bq - 1 < next) next = Math.max(i, bq - 1);
    if (next >= n) break;
    i = next;
    const c = t[i];
    let end = -1, keep = 0;
    if (c === '[') end = matchLinkLike(t, i);
    if (end < 0) {
      const pm = matchPrecode(t, i);
      if (pm) { end = pm.end; keep = pm.b; }
    }
    if (end < 0 && c === '<') end = matchHtmlTag(t, i);
    if (end > 0) {
      for (let k = i + keep; k < end; k++) masked[k] = 1;
      i = end;
    } else i++;
  }
  return masked;
}

// Jump-scan for the inline tokenizer: the next position holding a char
// that can start an inline construct. Everything between two such chars
// is plain text — unless it holds a bare-autolink trigger, in which case
// the slow char-by-char path below still handles it exactly as before.
const SPECIAL_RE = /[\\`*_~&\n<\[]|!/g;
const AUTO_TRIG_RE = /@|https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:/i;

function tokenizeInline(src, refs, noLinks, noExtAuto, istate) {
  istate = istate || { inLink: false };
  const nodes = [];
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ k: 't', s: buf }); buf = ''; } };
  let i = 0;
  const n = src.length;
  // Masking only matters when a delimiter run exists AND the text can
  // contain a maskable span (code span needs '`', link-like needs '[',
  // HTML tag needs '<'). Plain prose skips both masking passes entirely.
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const maskedArr = (hasDelim && (src.includes('`') || src.includes('[') || src.includes('<'))) ? computeMask(src) : null;
  while (i < n) {
    // Fast path: jump (one C-level scan) to the next special char. The
    // plain run in between is appended to buf in a single rope concat
    // when it holds no bare-autolink trigger; a run with a trigger falls
    // through to the char-by-char dispatch below, which is unchanged.
    // (lastIndex is set before every exec, so the shared /g regex stays
    // correct across the re-entrant tokenizeInline calls from tryLink.)
    SPECIAL_RE.lastIndex = i;
    const sm = SPECIAL_RE.exec(src);
    const nxt = sm ? sm.index : n;
    if (nxt > i) {
      // Trigger test: an email starting in this run can extend past the
      // next special when that special is itself an email char
      // ('_', '*', '~', '&', '!', '`' all occur in email local parts,
      // e.g. `a.b-c_d@a.b` spans the '_'). Extend the tested slice to
      // the end of the email-charset run when it continues past nxt;
      // the appended text still stops at nxt.
      let testEnd = nxt;
      if (nxt < n) {
        const nc = src.charCodeAt(nxt);
        if (nc < 128 && EMAIL_CHARS[nc]) {
          let j = nxt;
          while (j < n) { const c2 = src.charCodeAt(j); if (c2 >= 128 || !EMAIL_CHARS[c2]) break; j++; }
          testEnd = j;
        }
      }
      const seg = src.slice(i, testEnd);
      if (!AUTO_TRIG_RE.test(seg)) { buf += src.slice(i, nxt); i = nxt; if (i >= n) break; }
    }
    const c = src[i];
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') { flush(); nodes.push({ k: 'br' }); i += 2; while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; continue; }
      if (nx && ASCII_PUNCT(nx)) {
        if (nx === '&') { flush(); nodes.push({ k: 'e', s: '&' }); }
        else buf += nx;
        i += 2; continue;
      }
      buf += c; i++;
      continue;
    }
    if (c === '`') {
      let run = 0;
      while (i + run < n && src[i + run] === '`') run++;
      const ticks = '`'.repeat(run);
      const close = findCodeClose(src, i + run, run);
      if (close >= 0) {
        let content = src.slice(i + run, close);
        content = content.replace(/\n/g, ' ');
        if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flush();
        nodes.push({ k: 'code', s: content });
        i = close + run;
        continue;
      }
      buf += ticks; i += run;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let run = 0;
      while (i + run < n && src[i + run] === c) run++;
      if (c === '~' && run > 2) { buf += '~'.repeat(run); i += run; continue; }
      const prev = i > 0 ? src[i - 1] : '';
      const next = i + run < n ? src[i + run] : '';
      const leftFlank = next !== '' && !isWs(next) && (!isPunct(next) || prev === '' || isWs(prev) || isPunct(prev));
      const rightFlank = prev !== '' && !isWs(prev) && (!isPunct(prev) || next === '' || isWs(next) || isPunct(next));
      let co, cc;
      if (c === '*') { co = leftFlank; cc = rightFlank; }
      else if (c === '_') { co = leftFlank && (!rightFlank || isPunct(prev)); cc = rightFlank && (!leftFlank || isPunct(next)); }
      else { co = leftFlank; cc = rightFlank; }
      flush();
      nodes.push({ k: 'd', ch: c, len: run, co, cc, prev, next, pre: 0, masked: maskedArr ? !!maskedArr[i] : false });
      i += run;
      continue;
    }
    if (c === '&') {
      const d = decodeEntity(src, i);
      if (d) {
        if (d[0] === '&') { flush(); nodes.push({ k: 'e', s: '&' }); }
        else buf += d[0];
        i = d[1]; continue;
      }
      buf += '&'; i++;
      continue;
    }
    if (c === '\n') {
      const m = /[ \t]{2,}$/.exec(buf);
      if (m) {
        buf = buf.slice(0, buf.length - m[0].length); flush(); nodes.push({ k: 'br' });
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else { buf += '\n'; i++; }
      continue;
    }
    if (c === '<') {
      // Autolinks and raw HTML both start with a letter, '/', '!' or
      // '?'; anything else can never match, so skip the two regexes.
      const nx = src[i + 1];
      if (nx && /[A-Za-z\/!?]/.test(nx)) {
      // autolink <scheme:...> or <email>
      const rest = src.slice(i + 1);
      const am = AUTOLINK_RE.exec(rest);
      if (am && !noLinks) {
        const href = am[0].slice(0, -1);
        const clean = cleanUrl(href.includes(':') ? href : 'mailto:' + href);
        if (clean !== null) {
          flush();
          nodes.push({ k: 'link', href: clean, title: null, inner: escapeHtml(href), auto: 1 });
          i += 1 + am[0].length;
          continue;
        }
      }
      // inline raw html
      const hm = INLINE_HTML_RE.exec(src.slice(i));
      if (hm) {
        // Document-level lexer state (marked's state.inLink): an unclosed
        // <a ...> suppresses every later bare-URL/email autolink in the
        // whole document until a </a> clears it.
        if (!istate.inLink && /^<a /i.test(hm[0])) istate.inLink = true;
        else if (istate.inLink && /^<\/a>/i.test(hm[0])) istate.inLink = false;
        flush(); nodes.push({ k: 'html', s: hm[0] }); i += hm[0].length; continue;
      }
      }
      buf += '<'; i++;
      continue;
    }
    if (!noLinks && c === '[') {
      const lk = tryLink(src, i, refs, false, istate);
      if (lk) { flush(); nodes.push(lk.node); i = lk.end; continue; }
      buf += '['; i++;
      continue;
    }
    if (!noLinks && c === '!' && src[i + 1] === '[') {
      const lk = tryLink(src, i + 1, refs, true, istate);
      if (lk) { flush(); nodes.push(lk.node); i = lk.end; continue; }
      buf += '!'; i++;
      continue;
    }
    if (!noLinks && !noExtAuto && !istate.inLink && (c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F')) {
      // Bare scheme/www URLs: check the (short) prefix by hand, then scan
      // only to the end of the URL candidate — never slice the rest of
      // the paragraph. Equivalent to SCHEME_RE/WWW_RE on the remainder.
      let uEnd = -1;
      if (schemeLen(src, i)) uEnd = urlEnd(src, i);
      else if (c === 'w' && src.startsWith('www.', i) && (i === 0 || /[\s(*_~]/.test(src[i - 1]))) uEnd = urlEnd(src, i);
      if (uEnd > 0) {
        const u = trimUrlTail(src.slice(i, uEnd));
        if (u.length > 4) {
          const href = u.startsWith('www.') ? 'http://' + u : u;
          const clean = cleanUrl(href);
          if (clean !== null) {
            flush();
            nodes.push({ k: 'link', href: clean, title: null, inner: escapeHtml(u), auto: 1 });
            i += u.length;
            continue;
          }
        }
      }
      // email extended autolink (word starts only): only attempt when
      // the word actually contains '@'; the regex sees a word slice.
      if (i === 0 || !/[A-Za-z0-9._%+-]/.test(src[i - 1])) {
        const wEnd = wordEndWithAt(src, i);
        if (wEnd >= 0) {
          const em = EMAIL_RE.exec(src.slice(i, wEnd));
          if (em && emailTailOk(src, i + em[0].length, nodes)) {
            let u = em[0];
            while (u.length && /[.,;:!?]/.test(u[u.length - 1])) u = u.slice(0, -1);
            if (u.includes('@')) {
              const clean = cleanUrl('mailto:' + u);
              if (clean !== null) {
                flush();
                nodes.push({ k: 'link', href: clean, title: null, inner: escapeHtml(u), auto: 1 });
                i += u.length;
                continue;
              }
            }
          }
        }
      }
      buf += c; i++;
      continue;
    }
    if (!noLinks && !noExtAuto && !istate.inLink && (c === 'm' || c === 'x') && (i === 0 || !/[A-Za-z0-9._%+-]/.test(src[i - 1]))) {
      // mailto:/xmpp: — literal prefix check, then a word-bounded email.
      let plen = 0;
      if (src.startsWith('mailto:', i)) plen = 7;
      else if (src.startsWith('xmpp:', i)) plen = 5;
      if (plen) {
        const wEnd = wordEndWithAt(src, i + plen);
        const em = wEnd >= 0 ? EMAIL_RE.exec(src.slice(i + plen, wEnd)) : null;
        if (em && emailTailOk(src, i + plen + em[0].length, nodes)) {
          let u = src.slice(i, i + plen) + em[0];
          if (plen === 5 && src[i + u.length] === '/') {
            let q = i + u.length + 1;
            while (q < src.length && /[A-Za-z0-9.@]/.test(src[q])) q++;
            if (q > i + u.length + 1) u += src.slice(i + u.length, q);
          }
          const clean = cleanUrl(u);
          if (clean !== null) {
            flush();
            nodes.push({ k: 'link', href: clean, title: null, inner: escapeHtml(u), auto: 1 });
            i += u.length;
            continue;
          }
        }
      }
    }
    if (!noLinks && !noExtAuto && !istate.inLink && /[A-Za-z0-9._%+-]/.test(c) && (i === 0 || !/[A-Za-z0-9._%+-]/.test(src[i - 1]))) {
      // email may start mid-text (preceded by space/punct handled above only for w/h/f);
      // try email at any word start — but only if the word has an '@'.
      const wEnd = wordEndWithAt(src, i);
      if (wEnd >= 0) {
        const em = EMAIL_RE.exec(src.slice(i, wEnd));
        if (em && emailTailOk(src, i + em[0].length, nodes)) {
          let u = em[0];
          while (u.length && /[.,;:!?]/.test(u[u.length - 1])) u = u.slice(0, -1);
          const clean = cleanUrl('mailto:' + u);
          if (clean !== null) {
            flush();
            nodes.push({ k: 'link', href: clean, title: null, inner: escapeHtml(u) });
            i += u.length;
            continue;
          }
        }
      }
      buf += c; i++;
      continue;
    }
    buf += c; i++;
  }
  flush();
  processDelims(nodes);
  return nodes;
}
function inlineParse(src, refs, noLinks, istate) {
  // istate: shared document-level state (inLink), passed through so the
  // bare-autolink suppression survives across deferred inline renders.
  // Plain-text fast path: with no inline-construct starter
  // (\, `, *, _, ~, &, <, [), no bare-autolink trigger and no hard-break
  // (two spaces before a newline), the text renders as escaped text and
  // nothing else can happen — no nodes, no emphasis scan, no masking.
  // (No '<' also means no <a> tag, so istate is untouched.)
  if (!/[\\`*_~&<\[]/.test(src) && !/ {2,}\n/.test(src) && (noLinks || !AUTO_TRIG_RE.test(src))) {
    return escapeHtml(src);
  }
  return renderNodes(tokenizeInline(src, refs, noLinks, undefined, istate));
}
function hasLink(nodes) {
  for (const nd of nodes) {
    if (nd.k === 'link' && !nd.auto) return true;
    if ((nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') && hasLink(nd.kids)) return true;
  }
  return false;
}

// canOpen/canClose for a delimiter run of `ch` given its neighbours
// (prev/next are single chars or ''). Same flanking rules the tokenizer
// uses; needed for delimiter nodes created during emphasis resolution
// (leftover runs, split-and-retry).
function delimCoCc(ch, prev, next) {
  const leftFlank = next !== '' && !isWs(next) && (!isPunct(next) || prev === '' || isWs(prev) || isPunct(prev));
  const rightFlank = prev !== '' && !isWs(prev) && (!isPunct(prev) || next === '' || isWs(next) || isPunct(next));
  if (ch === '*') return { co: leftFlank, cc: rightFlank };
  if (ch === '_') return { co: leftFlank && (!rightFlank || isPunct(prev)), cc: rightFlank && (!leftFlank || isPunct(next)) };
  return { co: leftFlank, cc: rightFlank };
}
function makeDelimNode(ch, len, prev, next) {
  const cc = delimCoCc(ch, prev, next);
  return { k: 'd', ch, len, co: cc.co, cc: cc.cc, prev, next, pre: 0 };
}

// Marked's RDelim first alternative skips a `*` sitting inside a
// `__...__` pair (for a `*` opener) or a `_` inside a `**...**` pair
// (for a `_` opener), when the pair starts at the beginning of the
// remaining string. Returns the delimiter node index to skip, or -1.
function findSkippedInner(nodes, oi, ch) {
  const opp = ch === '*' ? '_' : '*';
  let state = 0, innerIdx = -1;
  for (let k = oi + 1; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.k !== 'd' || nd.masked) continue; // masked delimiters read as 'a's in the scan text
    if (nd.ch !== '*' && nd.ch !== '_') continue; // ~ does not block
    if (state === 0) {
      if (nd.ch === opp && nd.len === 2) { state = 1; continue; }
      return -1;
    }
    if (state === 1) {
      if (nd.ch === ch && nd.len === 1) { innerIdx = k; state = 2; continue; }
      return -1;
    }
    // state === 2
    if (nd.ch === opp && nd.len === 2) return innerIdx;
    return -1;
  }
  return -1;
}

// Marked's opener-driven emStrong scan for the opener at nodes[oi]
// (a '*' or '_' delimiter node that can open). Returns
// {closerIdx, use, kind} or null; `use` is how many closer delimiters
// are consumed, kind is 'em' or 'strong'.
function emStrongScan(nodes, oi) {
  const op = nodes[oi];
  const ch = op.ch;
  const k = op.len;
  // y is the length of the WHOLE delimiter run holding this opener:
  // delimiters already split off as literal text just before it (op.pre)
  // plus the current run. The %3 rule keys off y, not the current run.
  const y = (op.pre || 0) + op.len;
  let m = k, f = 0;
  // R flag: the char before the WHOLE run is non-whitespace, and (the char
  // after the opener is punctuation, or the opener is '*' and the char
  // before the whole run is not punctuation/a delimiter). op.prev is the
  // char before the whole run and never changes across split-and-retry;
  // the char right before the shortened run is the split-off delimiter
  // itself and only affects co/cc, not R.
  const prev = op.prev ?? '', nextPunct = op.next !== '' && isPunct(op.next);
  const prevPunct = prev !== '' && isPunct(prev);
  const prevWs = prev === '' || isWs(prev);
  const h = prev === '*' || prev === '_' || prevPunct;
  const R = !prevWs && (nextPunct || (ch === '*' && !h));
  // o flag: the char before the opener (last char of the preceding text
  // node) is the same delimiter char.
  let o = false;
  if (oi > 0) {
    const pv = nodes[oi - 1];
    if (pv.k === 't' && pv.s.length > 0 && pv.s[pv.s.length - 1] === ch) o = true;
  }
  const skipIdx = findSkippedInner(nodes, oi, ch);
  for (let j = oi + 1; j < nodes.length; j++) {
    if (j === skipIdx) continue;
    const nd = nodes[j];
    if (nd.k !== 'd' || nd.ch !== ch || nd.masked || (!nd.co && !nd.cc)) continue;
    const b = nd.len;
    if (nd.co && !nd.cc) { m += b; continue; } // opener-only: add, skip
    if ((nd.co && nd.cc) || R) {
      if (o && nd.co && nd.cc) return null; // ambiguous + same prev: stop
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; } // %3 skip
    }
    m -= b;
    if (m > 0) continue;
    const use = Math.min(b, b + m + f);
    const kind = (Math.min(k, use) % 2 === 1) ? 'em' : 'strong';
    return { closerIdx: j, use, kind };
  }
  return null;
}

// Marked's opener-driven del scan for the '~' opener at nodes[oi].
// Equal-length runs only, no %3 rule, no R flag.
function delScan(nodes, oi) {
  const op = nodes[oi];
  const o = op.len;
  let p = o;
  for (let j = oi + 1; j < nodes.length; j++) {
    const nd = nodes[j];
    if (nd.k !== 'd' || nd.ch !== '~' || nd.masked || (!nd.co && !nd.cc)) continue;
    const l = nd.len;
    if (l !== o) continue;
    if (nd.co && !nd.cc) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    return { closerIdx: j, use: Math.min(l, l + p), kind: 'del' };
  }
  return null;
}

// Resolve emphasis/delimiters in nodes (in place) with marked's
// opener-driven emStrong/del scans. Matched spans become
// {k:'em'|'strong'|'del', kids} nodes.
function processDelims(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (nd.k !== 'd' || !nd.co) { i++; continue; }
    const scan = nd.ch === '~' ? delScan(nodes, i) : emStrongScan(nodes, i);
    if (!scan) {
      // No match for this opener run. Marked's text tokenizer then
      // consumes ONE delimiter as literal text and retries the scan on
      // the shortened run (e.g. `**foo*` -> `*` + `<em>foo</em>`,
      // `***foo**` -> `*` + `<strong>foo</strong>`).
      if (nd.len > 1) {
        nodes.splice(i, 0, { k: 't', s: nd.ch });
        nd.len--;
        nd.pre = (nd.pre || 0) + 1;
        // Recompute flanking with the split-off delimiter as the
        // immediately preceding char; nd.prev (char before the whole run)
        // stays unchanged for R/y.
        const cc = delimCoCc(nd.ch, nd.ch, nd.next ?? '');
        nd.co = cc.co; nd.cc = cc.cc;
        i++; // point at the shortened delimiter node; retry it
        continue;
      }
      i++;
      continue;
    }
    const op = nd;
    const closer = nodes[scan.closerIdx];
    const strip = scan.kind === 'em' ? 1 : scan.kind === 'strong' ? 2 : op.len;
    // kids: leftover opener delimiters + inner nodes + leftover closer
    // delimiters (end of inner text)
    const kids = [];
    if (op.len > strip) kids.push(makeDelimNode(op.ch, op.len - strip, '', op.next ?? ''));
    for (let k = i + 1; k < scan.closerIdx; k++) kids.push(nodes[k]);
    if (scan.use > strip) kids.push(makeDelimNode(closer.ch, scan.use - strip, closer.prev ?? '', ''));
    const emNode = { k: scan.kind, kids };
    // marked parses the inner text fresh; resolve it recursively
    processDelims(kids);
    const replacement = [emNode];
    if (closer.len > scan.use) {
      // the closer run has delimiters left after the matched `use`
      const rest = { ...closer, len: closer.len - scan.use };
      replacement.push(rest);
    }
    nodes.splice(i, scan.closerIdx - i + 1, ...replacement);
    // continue after the em node; re-process a leftover closer run
    i = i + 1;
    if (closer.len > scan.use) i--;
  }
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 't') out += escapeHtml(nd.s);
    else if (nd.k === 'd') out += escapeHtml(nd.ch.repeat(nd.len));
    else if (nd.k === 'code') out += '<code>' + escapeCode(nd.s) + '</code>';
    else if (nd.k === 'br') out += '<br>';
    else if (nd.k === 'e') out += '&amp;';
    else if (nd.k === 'html') out += nd.s;
    else if (nd.k === 'link') {
      out += '<a href="' + escapeAttr(nd.href) + '"' + (nd.title != null ? ' title="' + escapeAttr(nd.title) + '"' : '') + '>' + nd.inner + '</a>';
    } else if (nd.k === 'img') {
      out += '<img src="' + escapeAttr(nd.href) + '" alt="' + escapeAttr(nd.alt) + '"' + (nd.title != null ? ' title="' + escapeAttr(nd.title) + '"' : '') + '>';
    } else if (nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') {
      out += '<' + nd.k + '>' + renderNodes(nd.kids) + '</' + nd.k + '>';
    }
  }
  return out;
}
