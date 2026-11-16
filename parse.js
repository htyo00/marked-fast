// A fast drop-in for marked 18.1.3 (default options: gfm on, breaks off).
// Written from scratch for this competition: it reads a markdown string and
// returns exactly the HTML marked would produce, but without building a token
// tree first. Blocks are recognised with small anchored patterns, inline
// spans are scanned once, and emphasis follows marked's own closer search
// (a length-preserving mask plus a delimiter-run walk) so the tricky cases
// land the same way. No dependencies, no I/O, no state kept between calls.

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const ALPHA_NUM = /[\p{L}\p{N}]/u;
const WORD_CH = /[\w]/;

function isPunct(ch) { return ch !== '' && PUNCT.test(ch); }
function isPunctSpace(ch) { return ch !== '' && PUNCT_SPACE.test(ch); }
function isNotPunctSpace(ch) { return ch !== '' && NOT_PUNCT_SPACE.test(ch); }
function isAlphaNum(ch) { return ch !== '' && ALPHA_NUM.test(ch); }
function isSpaceCh(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'; }

// --- character-reference decoding -------------------------------------------
// Only numeric references are decoded (named ones pass through untouched):
// &#169; -> ©, &#xA9; -> ©, &#0; / surrogates / >0x10FFFF -> U+FFFD,
// &#38; -> &amp; (the decoded & is escaped again, never re-read as an entity).
const NUM_REF = /&#(\d{1,7});|&#[Xx]([A-Fa-f0-9]{1,6});/g;
const NUM_REF_TEST = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const AMP_NOT_REF = /&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function decodeRefs(s) {
  if (!NUM_REF_TEST.test(s)) return s;
  NUM_REF.lastIndex = 0;
  return s.replace(NUM_REF, (m, dec, hex) => {
    const n = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

// Escape text for HTML output. `encode` true escapes every & (code spans,
// autolink hrefs); false leaves a & alone when it starts a valid reference.
function esc(s, encode) {
  s = decodeRefs(s);
  if (encode) return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  return s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) => ESC_MAP[c] || '&amp;');
}

// Same escape step without decoding numeric references first: for code
// blocks, code spans, link destinations, titles and alt text, where
// marked applies only the plain escape.
function escRaw(s, encode) {
  if (encode) return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  return s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) => ESC_MAP[c] || '&amp;');
}

// Clean a link destination the way marked does: encode it as a URI, then
// turn %25 back into % (so an already-encoded % stays encoded). Returns null
// when encodeURI throws (e.g. a lone surrogate).
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

// Normalise a link label: trim, collapse inner whitespace, case-fold.
function normLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Strip trailing characters from a raw block: with `other` unset it removes
// trailing `ch`; with `other` set it removes trailing chars that are NOT `ch`.
function stripTail(s, ch, other) {
  let n = s.length, cut = 0;
  while (cut < n) {
    const c = s.charAt(n - cut - 1);
    if (c === ch && !other) cut++;
    else if (c !== ch && other) cut++;
    else break;
  }
  return cut ? s.slice(0, n - cut) : s;
}

// Drop trailing blank lines of a block, keeping the text when there is at
// most one trailing blank line.
function dropBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, tracking the column `start` is at.
function expandTabs(s, start) {
  let col = start || 0, out = '';
  for (const ch of s) {
    if (ch === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += ch; col++; }
  }
  return out;
}

// Remove up to `n` leading columns from a line (a tab counts to the next
// multiple of four and may be partly consumed, leaving spaces behind).
function stripCols(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { const w = 4 - (col % 4); if (col + w > n) return ' '.repeat(col + w - n) + line.slice(i + 1); col += w; i++; }
    else break;
  }
  return line.slice(i);
}

// Split a table row on unescaped pipes, honouring a wanted cell count.
function splitRow(row, count) {
  const t = row.replace(/\|/g, (m, off, str) => {
    let escaped = false, p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(/ \|/);
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Find the index where parens go unbalanced in `s` (skipping \x escapes):
// -1 balanced, -2 unclosed, otherwise the index of the extra closer.
function parenBalance(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}



// ============================ inline: regexes ============================
// Character classes for the emphasis machinery. A tilde counts as
// "not punctuation" in the gfm flavours, because `~` opens strikethrough
// rather than emphasis.
const PUNCT_S = '[\\p{P}\\p{S}]';
const PUNCT_SPACE_S = '[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_S = '[^\\s\\p{P}\\p{S}]';
const PUNCT_G = '(?!~)[\\p{P}\\p{S}]';
const PUNCT_SPACE_G = '(?!~)[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_G = '(?:[^\\s\\p{P}\\p{S}]|~)';

// Closer patterns for `*`, `_` and `~`. The group that holds a run tells
// the caller how it interacts with the opener: groups 3-4 are runs that
// can never close, groups 5-6 close only when the opener could open,
// groups 1-2 are ordinary closers. (`_` has no group 6.)
const EM_R_AST = new RegExp(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' +
  '|[^*]+(?=[^*])' +
  '|(?!\\*)' + PUNCT_G + '(\\*+)(?=[\\s]|$)' +
  '|' + NOT_PUNCT_G + '(\\*+)(?!\\*)(?=' + PUNCT_SPACE_G + '|$)' +
  '|(?!\\*)' + PUNCT_SPACE_G + '(\\*+)(?=' + NOT_PUNCT_G + ')' +
  '|[\\s](\\*+)(?!\\*)(?=' + PUNCT_G + ')' +
  '|(?!\\*)' + PUNCT_G + '(\\*+)(?!\\*)(?=' + PUNCT_G + ')' +
  '|' + NOT_PUNCT_G + '(\\*+)(?=' + NOT_PUNCT_G + ')', 'gu');
const EM_R_UND = new RegExp(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' +
  '|[^_]+(?=[^_])' +
  '|(?!_)' + PUNCT_G + '(_+)(?=[\\s]|$)' +
  '|' + NOT_PUNCT_G + '(_+)(?!_)(?=' + PUNCT_SPACE_G + '|$)' +
  '|(?!_)' + PUNCT_SPACE_G + '(_+)(?=' + NOT_PUNCT_G + ')' +
  '|[\\s](_+)(?!_)(?=' + PUNCT_G + ')' +
  '|(?!_)' + PUNCT_G + '(_+)(?!_)(?=' + PUNCT_G + ')', 'gu');
const DEL_R = new RegExp(
  '^[^~]+(?=[^~])' +
  '|(?!~)' + PUNCT_S + '(~~?)(?=[\\s]|$)' +
  '|' + NOT_PUNCT_S + '(~~?)(?!~)(?=' + PUNCT_SPACE_S + '|$)' +
  '|(?!~)' + PUNCT_SPACE_S + '(~~?)(?=' + NOT_PUNCT_S + ')' +
  '|[\\s](~~?)(?!~)(?=' + PUNCT_S + ')' +
  '|(?!~)' + PUNCT_S + '(~~?)(?!~)(?=' + PUNCT_S + ')' +
  '|' + NOT_PUNCT_S + '(~~?)(?=' + NOT_PUNCT_S + ')', 'gu');
const EM_L = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const DEL_L = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;

// Link labels. A label may nest one bracket group, escaped characters and
// code spans; a reference label may not nest brackets.
const NESTED = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*?\\]';
const LABEL = '(?:\\[(?:' + NESTED + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*?\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const REF = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const HREF = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const LINK_RE = new RegExp('^!?\\[(' + LABEL + ')\\]\\([ \\t\\n]*(' + HREF + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + TITLE + '))?[ \\t\\n]*\\)');
const REFLINK_RE = new RegExp('^!?\\[(' + LABEL + ')\\]\\[(' + REF + ')\\]');
const NOLINK_RE = new RegExp('^!?\\[(' + REF + ')\\](?:\\[\\])?');

// Masking label: the looser grammar used when hiding reference links from
// the emphasis scanner.
const LABEL_M = '(?:[^\\[\\]`]*(?:\\[(?:' + NESTED + '|\\\\[\\s\\S]|[^\\[\\]])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]`]*?';
const REFLINK_SEARCH = new RegExp('!?\\[(' + LABEL_M + ')\\]\\[(' + REF + ')\\]|!?\\[(' + REF + ')\\](?:\\[\\])?(?!\\()', 'g');
// Anything the emphasis scanner must not see as punctuation: inline links,
// code spans and html tags are replaced by same-length filler.
const BLOCK_SKIP = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\()]|\\((?:\\\\[\\s\\S]|[^\\\\()])*\\))*\\)' +
  '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)' +
  '|<(?! )[^<>]*?>', 'g');
// Escaped punctuation and code spans, for masking punctuation only.
const ANY_PUNCT_OUTSIDE_CODE = new RegExp('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])', 'gu');

const ESCAPE_RE = /^\\([!"#$%&'()*+,\-.\/:;<=>?@\[\]\\^_`{|}~])/;
const CODE_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const TAG_RE = /^(?:<!--(?:-?>|[\s\S]*?-->)|<\/?[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>)/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_RAW_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_RAW_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const UNESC_PUNCT = /\\([\p{P}\p{S}])/gu;

// Bare URLs and autolinks. The email pattern has a capture group only on
// the `@` in the bare-email and autolink forms, so group 2 being "@" is
// exactly the "this is a bare email" signal.
const EMAIL_NG = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EMAIL_G = '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const URL_RE = new RegExp('^(?:mailto:' + EMAIL_NG + '|xmpp:' + EMAIL_NG + '(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^' + EMAIL_G);
const AUTOLINK_RE = new RegExp('^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|' + EMAIL_G + ')>');
const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// A character counts as "punctuation" for emphasis flanking when it is
// punctuation or whitespace but not a delimiter itself.
function isPunctRule(ch) {
  return ch !== '' && ch !== '*' && ch !== '_' && /[\s\p{P}\p{S}]/u.test(ch);
}

// Hide reference links from the emphasis scanner: a resolved reference
// becomes filler of the same length, unless its label itself contains a
// link, in which case only the reference part is hidden.
function maskReflink(m, links) {
  const i = m.lastIndexOf('[');
  if (!links.has(normLabel(m.slice(i + 1, -1)))) return m;
  if (i > 1 && m.charAt(0) !== '!' && hasLinkInText(m.slice(1, i - 1), links)) {
    return '[' + m.slice(1, i - 1).replace(REFLINK_SEARCH, (x) => maskReflink(x, links)) + '][' + 'a'.repeat(m.length - i - 2) + ']';
  }
  return '[' + 'a'.repeat(m.length - 2) + ']';
}

// True when the text contains a link (inline or resolved reference) that
// is not an image.
function hasLinkInText(e, links) {
  if (!e.includes('[')) return false;
  for (const m of e.matchAll(BLOCK_SKIP)) {
    if (LINK_RE.test(m[0]) && e.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of e.matchAll(REFLINK_SEARCH)) {
    const s = m[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !links.has(normLabel(s.slice(r + 1, -1)))) && !(r > 1 && hasLinkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// The masked view of an inline string: reference links, escaped
// punctuation, code spans and tags are replaced by same-length filler so
// the emphasis scanner only sees real delimiters.
function maskInline(src, links) {
  let t = src;
  if (links.size && src.indexOf('[') !== -1) {
    t = t.replace(REFLINK_SEARCH, (m) => maskReflink(m, links));
  }
  t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (m, fence, punct) => punct ? '+'.repeat(m.length) : fence ? fence + m.slice(fence.length, -fence.length).replace(/`/g, '+') + fence : m);
  t = t.replace(BLOCK_SKIP, (m, g1, g2) => {
    const o = g2 ? g2.length : 0;
    return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
  });
  return t;
}

// Index of the last delimiter run that could close emphasis, per
// delimiter, plus the last `~` run that could close strikethrough. A run
// only counts when the character before it is not whitespace.
function lastCloser(t) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  for (let s = 0; s < t.length; s++) {
    const r = t[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : t[s - 1];
    let i = s + 1;
    while (i < t.length && t[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') del = s; else em[r] = s;
    }
    s = i - 1;
  }
  return { em, del };
}

// Try to parse emphasis starting at the head of `orig`. `masked` is the
// full masked string, `prevCh` the character before this position in the
// original source, `closerIdx` the cached last-closer table for `masked`.
function tryEmStrong(orig, masked, prevCh, closerIdx) {
  const m = EM_L.exec(orig);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const ch = m[0][0];
  const samePrev = prevCh === ch;
  const i = masked.length - orig.length;
  let l = i;
  while (l > 0 && masked[l - 1] === ch) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || isPunctRule(p);
  let n = prevCh;
  if (l < i) n = p;
  const u = l < i ? h : isPunctRule(n);
  if (m[4] && n !== '' && ALPHA_NUM.test(n)) return null;
  const d = m[1] || m[3] || '';
  if (!d || !n || u) {
    const k = [...m[0]].length - 1;
    let debt = k, extra = 0;
    const y = i - l + k;
    const R = p.trim() !== '' && (!!d || (ch === '*' && !h));
    if (ch !== '*' && ch !== '_') return null;
    const rdelim = ch === '*' ? EM_R_AST : EM_R_UND;
    const v = closerIdx[ch];
    const Q = masked.length - orig.length + k;
    if (v < Q) return null;
    const search = masked.slice(masked.length - orig.length + k);
    const ee = v - Q;
    rdelim.lastIndex = 0;
    let s;
    while ((s = rdelim.exec(search)) !== null && !(s.index > ee)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let b = [...g].length;
      if (s[3] || s[4]) { debt += b; continue; }
      if (s[5] || s[6] || R) {
        if (samePrev && (s[5] || s[6])) break;
        if (y % 3 && (y + b) % 3 === 0) { extra += b; continue; }
      }
      debt -= b;
      if (debt > 0) continue;
      b = Math.min(b, b + debt + extra);
      const te = [...s[0]][0].length;
      const raw = orig.slice(0, k + s.index + te + b);
      if (Math.min(k, b) % 2) return { raw, inner: raw.slice(1, -1), strong: false };
      return { raw, inner: raw.slice(2, -2), strong: true };
    }
  }
  return null;
}

// Try to parse strikethrough starting at the head of `orig`. The closer
// run must be exactly as long as the opener run; runs longer than two
// never close.
function tryDel(orig, masked, prevCh, delLast) {
  const m = DEL_L.exec(orig);
  if (!m) return null;
  if (!(m[1] || '') || !prevCh || isPunctRule(prevCh)) {
    const openLen = [...m[0]].length - 1;
    let debt = openLen;
    const d = masked.length - orig.length + openLen;
    if (delLast < d) return null;
    const search = masked.slice(masked.length - orig.length + openLen);
    const k = delLast - d;
    DEL_R.lastIndex = 0;
    let s;
    while ((s = DEL_R.exec(search)) !== null && !(s.index > k)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      const len = [...g].length;
      if (len !== openLen) continue;
      if (s[3] || s[4]) { debt += len; continue; }
      debt -= len;
      if (debt > 0) continue;
      const use = Math.min(len, len + debt);
      const te = [...s[0]][0].length;
      const raw = orig.slice(0, openLen + s.index + te + use);
      return { raw, inner: raw.slice(openLen, -openLen) };
    }
  }
  return null;
}

// Reject a link when its label swallows an html tag or autolink that
// reaches past the label's end.
function labelSwallowsTag(src, label, startIdx) {
  for (let s = 0; s < label.length; s++) {
    const r = label[s];
    if (r === '\\') { s++; continue; }
    if (r === '`') {
      let i = s, o = 0;
      while (i < label.length && label[i] === '`') { i++; o++; }
      let l = i;
      for (; l < label.length; l++) {
        if (label[l] === '`') {
          let h = 0;
          while (l + h < label.length && label[l + h] === '`') h++;
          if (h === o) { s = l + h - 1; break; }
        }
      }
      continue;
    }
    if (r === '<') {
      const rest = src.slice(startIdx + s);
      const o = TAG_RE.exec(rest) || AUTOLINK_RE.exec(rest);
      if (o) {
        if (o[0].length > label.length - s) return true;
        s += o[0].length - 1;
      }
    }
  }
  return false;
}

// Build the link/image result for a matched link form. The label is
// rendered inline with `inLink` held true; if a nested link appears
// inside a non-image label, the outer link is rejected.
function buildLink(m, href, title, ctx, plain) {
  const isImage = m[0].charAt(0) === '!';
  const label = m[1].replace(/\\([\[\]])/g, '$1');
  const savedInLink = ctx.inLink, savedEmitted = ctx.linkEmitted;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = renderInline(label, ctx, isImage ? true : plain, false);
  const nested = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  if (!isImage) {
    if (nested) return null;
    ctx.linkEmitted = true;
  }
  return { raw: m[0], href, title: title || null, isImage, inner };
}

function unescPunct(s) {
  return s.replace(UNESC_PUNCT, '$1');
}

// Inline link `[label](href "title")`, with the paren-balance and
// escaped-closer adjustments.
function tryLink(src, ctx, plain) {
  if (ctx.linkParenPossible === false) return null;
  const m = LINK_RE.exec(src);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelSwallowsTag(src, m[1], labelStart)) return null;
  const s = m[2].trim();
  if (s.startsWith('<')) {
    if (!s.endsWith('>')) return null;
    const l = stripTail(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = parenBalance(m[2]);
    if (l === -2) return null;
    if (l > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
      m[2] = m[2].substring(0, l);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const r = stripTail(m[0].slice(0, -1), '\\');
  if ((m[0].length - r.length) % 2 === 0) return null;
  let o = m[2].trim();
  const i = m[3] ? m[3].slice(1, -1) : '';
  if (o.startsWith('<')) o = o.slice(1, -1);
  return buildLink(m, o ? unescPunct(o) : '', i ? unescPunct(i) : '', ctx, plain);
}

// Reference link `[label][ref]`, collapsed `[label][]` or shortcut
// `[label]`. Returns `{ notFound: true }` when the label has no
// definition, so the caller can emit just the first character as text.
function tryRefLink(src, ctx, plain) {
  const m = REFLINK_RE.exec(src) || NOLINK_RE.exec(src);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelSwallowsTag(src, m[1], labelStart)) return null;
  const ref = ctx.links.get(normLabel(m[2] || m[1]));
  if (!ref) return { notFound: true, first: m[0].charAt(0) };
  return buildLink(m, ref.href, ref.title, ctx, plain);
}

// Code span: newlines become spaces, and a single leading/trailing space
// pair is stripped when the content has any non-space character.
function tryCodeSpan(src) {
  const m = CODE_RE.exec(src);
  if (!m) return null;
  let n = m[2].replace(/\n/g, ' ');
  const hasNonSpace = /[^ ]/.test(n);
  const wrapped = n.startsWith(' ') && n.endsWith(' ');
  if (hasNonSpace && wrapped) n = n.substring(1, n.length - 1);
  return { raw: m[0], text: n };
}

// Angle autolink `<scheme:...>` or `<email>`.
function tryAutolink(src) {
  const m = AUTOLINK_RE.exec(src);
  if (!m) return null;
  const text = m[1];
  const href = m[2] === '@' ? 'mailto:' + text : text;
  return { raw: m[0], text, href };
}

// Bare URL or bare email. Trailing punctuation is trimmed back, except
// for bare emails, which the address grammar already bounds.
function tryBareUrl(src) {
  const m = URL_RE.exec(src);
  if (!m) return null;
  if (m[2] === '@') return { raw: m[0], text: m[0], href: 'mailto:' + m[0] };
  let raw = m[0], prev = raw;
  do {
    prev = raw;
    const b = BACKPEDAL.exec(raw);
    raw = b ? b[0] : '';
  } while (raw !== prev);
  return { raw, text: raw, href: m[1] === 'www.' ? 'http://' + raw : raw };
}

// ============================ inline: scanner ============================
const LOCAL_PUNCT = ".!#$%&'*+/=?_`{|}~-";

function isLocalChar(c) {
  if (c === '') return false;
  const n = c.charCodeAt(0);
  if ((n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122)) return true;
  return LOCAL_PUNCT.indexOf(c) !== -1;
}
function isAlphaNumCh(c) {
  if (c === '') return false;
  const n = c.charCodeAt(0);
  return (n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122);
}
function isWordCh(c) {
  return c !== '' && (c === '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
}

// True when a bare `http://`, `https://` or `ftp://` (any case) starts
// at position j.
function matchScheme(src, j) {
  const c = src[j];
  if (c === 'h' || c === 'H') {
    if ((src[j + 1] === 't' || src[j + 1] === 'T') && (src[j + 2] === 't' || src[j + 2] === 'T') && (src[j + 3] === 'p' || src[j + 3] === 'P')) {
      if (src[j + 4] === ':') return src[j + 5] === '/' && src[j + 6] === '/';
      if ((src[j + 4] === 's' || src[j + 4] === 'S')) return src[j + 5] === ':' && src[j + 6] === '/' && src[j + 7] === '/';
    }
  } else if (c === 'f' || c === 'F') {
    if ((src[j + 1] === 't' || src[j + 1] === 'T') && (src[j + 2] === 'p' || src[j + 2] === 'P')) {
      return src[j + 3] === ':' && src[j + 4] === '/' && src[j + 5] === '/';
    }
  }
  return false;
}

// True when two or more spaces and then a newline start at k.
function hardBreakAt(src, k) {
  if (src[k] !== ' ' || src[k + 1] !== ' ') return false;
  let m = k;
  while (src[m] === ' ') m++;
  return src[m] === '\n';
}

// True when an email address local part plus `@` starts at j.
function emailLocalAt(src, j) {
  let k = j;
  while (k < src.length && isLocalChar(src[k])) k++;
  return k > j && src[k] === '@';
}

// End index (exclusive) of the plain-text run starting at i. The run
// stops before delimiters, tags, links, bare URLs and emails, and before
// a hard break; a non-alphanumeric character directly before `mailto:` or
// `xmpp:`, and a non-local character directly before an email address,
// are consumed as the run's last character.
function scanText(src, i, hasAt) {
  const n = src.length;
  let j = i;
  if (!isAlphaNumCh(src[j]) && (src.startsWith('mailto:', j + 1) || src.startsWith('xmpp:', j + 1))) return j + 1;
  if (src[j] === '`') { while (j < n && src[j] === '`') j++; }
  else if (src[j] === '~') { while (j < n && src[j] === '~') j++; }
  else j++;
  if (j < n && (src[j] === '`' || src[j] === '~')) return j;
  if (j < n && hardBreakAt(src, j)) return j;
  if (hasAt && j < n && emailLocalAt(src, j)) return j;
  while (j < n) {
    const c = src[j];
    if (c === '\\' || c === '<' || c === '!' || c === '[' || c === '`' || c === '*' || c === '~' || c === '_') break;
    if ((c === 'h' || c === 'H' || c === 'f' || c === 'F') && matchScheme(src, j)) break;
    if (c === 'w' && src.startsWith('www.', j) && (j === 0 || /[\s*_~(]/.test(src[j - 1]))) break;
    if (c !== ' ' && src[j + 1] === ' ' && hardBreakAt(src, j + 1)) { j++; break; }
    if (!isAlphaNumCh(c) && (src.startsWith('mailto:', j + 1) || src.startsWith('xmpp:', j + 1))) { j++; break; }
    if (hasAt && !isLocalChar(c) && emailLocalAt(src, j + 1)) { j++; break; }
    j++;
  }
  return j;
}

// Render a matched link or image. In plain mode (image alt text) the
// label's plain text is returned for both.
function renderLinkToken(r, plain) {
  if (plain) return r.inner;
  if (r.isImage) {
    const href = cleanUrl(r.href);
    if (href === null) return escRaw(r.inner);
    let o = '<img src="' + escRaw(href) + '" alt="' + escRaw(r.inner) + '"';
    if (r.title) o += ' title="' + escRaw(r.title) + '"';
    return o + '>';
  }
  const href = cleanUrl(r.href);
  if (href === null) return r.inner;
  let o = '<a href="' + escRaw(href) + '"';
  if (r.title) o += ' title="' + escRaw(r.title) + '"';
  return o + '>' + r.inner + '</a>';
}

function renderAuto(r) {
  const href = cleanUrl(r.href);
  if (href === null) return escRaw(r.text, true);
  return '<a href="' + escRaw(href, true) + '">' + escRaw(r.text, true) + '</a>';
}

// Render one inline string to HTML (or to plain text when `plain` is
// set, for image alt text). `ctx` carries the per-parse state: the link
// definitions, `inLink`, `inRawBlock`, `linkEmitted` and
// `linkParenPossible`.
function renderInline(src, ctx, plain, top) {
  if (!src) return '';
  if (top) ctx.inRawBlock = false;
  const savedParen = ctx.linkParenPossible;
  ctx.linkParenPossible = src.includes(')');
  let masked = null, closer = null;
  const needMask = () => {
    if (masked === null) {
      masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskInline(src, ctx.links) : src;
      closer = lastCloser(masked);
    }
    return masked;
  };
  let out = '', i = 0, prevCh = '', prevWasText = false;
  const n = src.length;
  // A bare email can only start in a string that contains `@`; most
  // strings do not, so the email lookahead is skipped for them.
  const hasAt = src.includes('@');
  while (i < n) {
    if (!prevWasText) prevCh = '';
    prevWasText = false;
    const rest = src.slice(i);
    const c = rest[0];
    if (c === '\\') {
      const m = ESCAPE_RE.exec(rest);
      if (m) { out += plain ? m[1] : escRaw(m[1]); i += m[0].length; continue; }
    }
    if (c === '<') {
      const m = TAG_RE.exec(rest);
      if (m) {
        const raw = m[0];
        if (!ctx.inLink && START_A_TAG.test(raw)) ctx.inLink = true;
        else if (ctx.inLink && END_A_TAG.test(raw)) ctx.inLink = false;
        if (!ctx.inRawBlock && START_RAW_TAG.test(raw)) ctx.inRawBlock = true;
        else if (ctx.inRawBlock && END_RAW_TAG.test(raw)) ctx.inRawBlock = false;
        out += raw;
        i += raw.length;
        continue;
      }
    }
    if (c === '[' || (c === '!' && rest[1] === '[')) {
      let r = tryLink(rest, ctx, plain);
      if (r) { out += renderLinkToken(r, plain); i += r.raw.length; continue; }
      r = tryRefLink(rest, ctx, plain);
      if (r) {
        if (r.notFound) { out += plain ? r.first : escRaw(r.first); i += 1; continue; }
        out += renderLinkToken(r, plain);
        i += r.raw.length;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const r = tryEmStrong(rest, needMask(), prevCh, closer.em);
      if (r) {
        const inner = renderInline(r.inner, ctx, plain, false);
        out += plain ? inner : (r.strong ? '<strong>' + inner + '</strong>' : '<em>' + inner + '</em>');
        i += r.raw.length;
        continue;
      }
    }
    if (c === '`') {
      const r = tryCodeSpan(rest);
      if (r) { out += plain ? r.text : '<code>' + escRaw(r.text, true) + '</code>'; i += r.raw.length; continue; }
    }
    if (c === ' ' || c === '\\') {
      const m = BR_RE.exec(rest);
      if (m) { if (!plain) out += '<br>'; i += m[0].length; continue; }
    }
    if (c === '~') {
      const r = tryDel(rest, needMask(), prevCh, closer.del);
      if (r) {
        const inner = renderInline(r.inner, ctx, plain, false);
        out += plain ? inner : '<del>' + inner + '</del>';
        i += r.raw.length;
        continue;
      }
    }
    if (c === '<') {
      const r = tryAutolink(rest);
      if (r) { out += plain ? r.text : renderAuto(r); i += r.raw.length; continue; }
    }
    // A bare URL can only start on a local character, and without `@`
    // in the string only a scheme (`http`/`https`/`ftp`/`mailto:`/
    // `xmpp:`) or `www.` can start one.
    if (!ctx.inLink && isLocalChar(c) && (hasAt || c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'w' || c === 'm' || c === 'x')) {
      const r = tryBareUrl(rest);
      if (r) { out += plain ? r.text : renderAuto(r); i += r.raw.length; continue; }
    }
    const end = scanText(src, i, hasAt);
    const chunk = src.slice(i, end);
    if (plain) out += ctx.inRawBlock ? chunk : decodeRefs(chunk);
    else out += ctx.inRawBlock ? chunk : esc(chunk);
    if (chunk.charAt(chunk.length - 1) !== '_') prevCh = chunk.charAt(chunk.length - 1);
    prevWasText = true;
    i = end;
  }
  ctx.linkParenPossible = savedParen;
  return out;
}

// ============================ block: regexes ============================
const BLOCK_TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_INTERRUPT = ' {0,3}(?:</?(?:' + BLOCK_TAG_LIST + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const FENCE_INTERRUPT = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HR_SRC_NC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';

const SPACE_RE = /^(?:[ \t]*(?:\n|$))+/;
const INDENTED_CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const CODE_DEDENT_RE = /^(?: {0,3}\t| {1,4})/gm;
const FENCE_RE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR_RE = new RegExp('^' + HR_SRC);
const HEADING_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULL_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const LIST_START_RE = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const BLANK_LINE_RE = /^[ \t]*$/;
const DOUBLE_BLANK_RE = /\n[ \t]*\n[ \t]*$/;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;

// Table: header line, delimiter row, optional body lines that do not
// start a new block.
const TABLE_SRC = ' *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|' + HR_SRC_NC + '|' + HEADING_SRC + '| {0,3}>|(?: {4}| {0,3}\\t)[^\\n]|' + FENCE_INTERRUPT + '| {0,3}(?:[*+-]|1[.)])[ \\t]|' + HTML_INTERRUPT + ').*(?:\\n|$))*)\\n*|$)';
const TABLE_RE = new RegExp('^' + TABLE_SRC);

// Paragraph: lines that do not start a new block. The table pattern is
// an interrupt here, and setext underlines are not (lheading is tried
// first in the block loop).
const PARA_RE = new RegExp('^([^\\n]+(?:\\n(?!' + HR_SRC + '|' + HEADING_SRC + '| {0,3}>|' + FENCE_INTERRUPT + '| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]|' + HTML_INTERRUPT + '|' + TABLE_SRC + '|[ \\t]+\\n)[^\\n]+)*)');
// The same paragraph shape used inside blockquotes, where any list
// marker (not just `1.`/`1)`) interrupts.
const PARA_BQ_RE = new RegExp('^([^\\n]+(?:\\n(?!' + HR_SRC + '|' + HEADING_SRC + '| {0,3}>|' + FENCE_INTERRUPT + '| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)|' + HTML_INTERRUPT + '|[ \\t]+\\n)[^\\n]+)*)');

// Setext heading: text lines followed by an `===` or `---` underline.
const LHEADING_RE = new RegExp('^(?!' + BULL_SRC + ' |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n)((?:.|\\n(?!\\s*?\\n|' + BULL_SRC + ' | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)|' + HR_SRC_NC + '| {0,3}<[^\\n>]+>\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)');

// Blockquote: `>` lines, plus any leading lines before the first `>`.
const BLOCKQUOTE_RE = new RegExp('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' + PARA_BQ_RE.source.slice(1) + ')|[^\\n]*)(?:\\n|$))+');

// HTML block, seven types: script/pre/style/textarea, comment,
// processing instruction, declaration, CDATA, block tag, other tag.
const HTML_RE = new RegExp(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
  '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)' +
  '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
  '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
  '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
  '|</?(?:' + BLOCK_TAG_LIST + ')(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
  '|<(?!((?:script|pre|style|textarea)(?![a-z0-9-])))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
  '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))', 'i');

// Link reference definition.
const DEF_RE = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const TEXT_RE = /^[^\n]+/;

// Per-indent begin-line tests, with the indent capped at three.
// The compiled patterns are cached per cap value (only 0-3 exist),
// because compiling the HTML one per list item was a hot spot.
function indentCap(n) { return Math.max(0, Math.min(3, n - 1)); }
const beginCache = [null, null, null, null];
function beginRegexes(n) {
  const a = indentCap(n);
  let c = beginCache[a];
  if (!c) {
    c = {
      v: new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`),
      q: new RegExp(`^ {0,${a}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`),
      ee: new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`),
      te: new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`),
      m: new RegExp(`^ {0,${a}}(?:</?(?:${BLOCK_TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
      ne: new RegExp(`^ {0,${a}}>`),
    };
    beginCache[a] = c;
  }
  return c;
}
function nextBulletRegex(n) { return beginRegexes(n).v; }
function hrRegex(n) { return beginRegexes(n).q; }
function fencesBeginRegex(n) { return beginRegexes(n).ee; }
function headingBeginRegex(n) { return beginRegexes(n).te; }
function htmlBeginRegex(n) { return beginRegexes(n).m; }
function blockquoteBeginRegex(n) { return beginRegexes(n).ne; }

// ============================ block: simple tokenizers ============================
function trySpace(src) {
  const t = SPACE_RE.exec(src);
  return t && t[0].length > 0 ? { raw: t[0] } : null;
}

function tryCode(src) {
  const t = INDENTED_CODE_RE.exec(src);
  if (!t) return null;
  const n = dropBlankTail(t[0]);
  return { kind: 'code', raw: n, text: n.replace(CODE_DEDENT_RE, ''), lang: '' };
}

// Strip the opening fence's indent from each content line. Only
// backtick fences dedent, and only when the opener itself is indented.
function dedentFence(raw, content) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (!m) return content;
  const s = m[1];
  return content.split('\n').map((r) => {
    const o = r.match(/^\s+/);
    if (!o) return r;
    return r.slice(Math.min(o[0].length, s.length));
  }).join('\n');
}

function tryFences(src) {
  const t = FENCE_RE.exec(src);
  if (!t) return null;
  return { kind: 'code', raw: t[0], text: dedentFence(t[0], t[3] || ''), lang: t[2] ? t[2].trim().replace(UNESC_PUNCT, '$1') : t[2] };
}

function tryHeading(src) {
  const t = HEADING_RE.exec(src);
  if (!t) return null;
  let n = t[2].trim();
  if (/#$/.test(n)) {
    const s = stripTail(n, '#');
    if (!s || /[ \t]$/.test(s)) n = s.trim();
  }
  return { kind: 'heading', raw: stripTail(t[0], '\n'), depth: t[1].length, text: n };
}

function tryHr(src) {
  const t = HR_RE.exec(src);
  return t ? { kind: 'hr', raw: stripTail(t[0], '\n') } : null;
}

function tryHtml(src) {
  const t = HTML_RE.exec(src);
  if (!t) return null;
  const n = dropBlankTail(t[0]);
  return { kind: 'html', raw: n, text: n, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style' };
}

function tryDef(src) {
  const t = DEF_RE.exec(src);
  if (!t) return null;
  if (!t[2].startsWith('<') && parenBalance(t[2]) !== -1) return null;
  return {
    kind: 'def',
    tag: normLabel(t[1]),
    raw: stripTail(t[0], '\n'),
    href: t[2] ? t[2].replace(/^<(.*)>$/, '$1').replace(UNESC_PUNCT, '$1') : '',
    title: t[3] ? t[3].substring(1, t[3].length - 1).replace(UNESC_PUNCT, '$1') : t[3],
  };
}

function tryTable(src) {
  const t = TABLE_RE.exec(src);
  if (!t || !/[:|]/.test(t[2])) return null;
  const header = splitRow(t[1]);
  const delim = t[2].replace(/^\||\| *$/g, '').split('|');
  const body = t[3] && t[3].trim() ? t[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  if (header.length !== delim.length) return null;
  const align = delim.map((c) => /^ *-+: *$/.test(c) ? 'right' : /^ *:-+: *$/.test(c) ? 'center' : /^ *:-+ *$/.test(c) ? 'left' : null);
  return {
    kind: 'table',
    raw: stripTail(t[0], '\n'),
    header: header.map((h, i) => ({ text: h, align: align[i] })),
    rows: body.map((row) => splitRow(row, header.length).map((c, i) => ({ text: c, align: align[i] }))),
  };
}

// Index of the first non-space character (string length when the
// string is all spaces).
function leadSpaces(s) {
  let k = 0;
  while (s.charCodeAt(k) === 32) k++;
  return k;
}

// Cheap pre-check for a setext underline: scan lines until a blank
// line; true when one looks like `===`/`---` (0-3 spaces, run of one
// mark, spaces/tabs to end of line). The setext text cannot cross a
// blank line, so a false answer proves the regex cannot match.
function hasSetextUnderline(src) {
  let i = 0;
  const n = src.length;
  while (i < n) {
    let j = i;
    while (src[j] === ' ') j++;
    const indent = j - i;
    let k = j;
    while (src[k] === ' ' || src[k] === '\t') k++;
    if (src[k] === '\n' || k >= n) return false;
    if (indent <= 3 && (src[j] === '=' || src[j] === '-')) {
      const mark = src[j];
      let m = j;
      while (src[m] === mark) m++;
      let t = m;
      while (src[t] === ' ' || src[t] === '\t') t++;
      if (src[t] === '\n' || t >= n) return true;
    }
    const nl = src.indexOf('\n', i);
    if (nl === -1) return false;
    i = nl + 1;
  }
  return false;
}

function tryLheading(src) {
  if (!hasSetextUnderline(src)) return null;
  const t = LHEADING_RE.exec(src);
  if (!t) return null;
  return { kind: 'heading', raw: stripTail(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text: t[1].trim() };
}

function tryParagraph(src) {
  const t = PARA_RE.exec(src);
  if (!t) return null;
  const n = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
  return { kind: 'para', raw: t[0], src: n };
}

function tryText(src) {
  const t = TEXT_RE.exec(src);
  return t ? { kind: 'text', raw: t[0], src: t[0] } : null;
}

// ============================ block: renderers ============================
function renderCode(r) {
  const langName = (r.lang || '').match(/^\S*/)?.[0] || '';
  const body = r.text ? r.text.replace(/\n$/, '') + '\n' : '';
  const esc = escRaw(body, true);
  return langName
    ? '<pre><code class="language-' + escRaw(langName) + '">' + esc + '</code></pre>\n'
    : '<pre><code>' + esc + '</code></pre>\n';
}

function renderTable(tab, ctx) {
  let head = '';
  for (const c of tab.header) head += (c.align ? `<th align="${c.align}">` : '<th>') + renderInline(c.text, ctx, false, true) + '</th>\n';
  let body = '';
  for (const row of tab.rows) {
    let cells = '';
    for (const c of row) cells += (c.align ? `<td align="${c.align}">` : '<td>') + renderInline(c.text, ctx, false, true) + '</td>\n';
    body += '<tr>\n' + cells + '</tr>\n';
  }
  return '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
}

function renderCheckbox(g) {
  return '<input ' + (g.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderListItem(u, ctx) {
  let inner = renderBlocks(u.tokens, ctx);
  return '<li>' + inner + '</li>\n';
}

function renderList(list, ctx) {
  const tag = list.ordered ? 'ol' : 'ul';
  const startAttr = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  let out = `<${tag}${startAttr}>\n`;
  for (const u of list.items) out += renderListItem(u, ctx);
  return out + `</${tag}>\n`;
}

// Render a run of block items. Paragraph and text items carry their
// inline source; `prefixHtml` (a task checkbox) is rendered inside the
// first paragraph of a loose list item.
function renderBlocks(items, ctx) {
  let out = '';
  for (const it of items) {
    if (it.kind === 'html') out += it.text;
    else if (it.kind === 'code') out += renderCode(it);
    else if (it.kind === 'para') out += '<p>' + (it.prefixHtml || '') + renderInline(it.src, ctx, false, true) + '</p>\n';
    else if (it.kind === 'text') out += (it.prefixHtml || '') + renderInline(it.src, ctx, false, true);
    else if (it.kind === 'heading') out += `<h${it.depth}>` + renderInline(it.text, ctx, false, true) + `</h${it.depth}>\n`;
    else if (it.kind === 'hr') out += '<hr>\n';
    else if (it.kind === 'blockquote') out += '<blockquote>\n' + renderBlocks(it.tokens, ctx) + '</blockquote>\n';
    else if (it.kind === 'list') out += renderList(it, ctx);
    else if (it.kind === 'table') out += renderTable(it, ctx);
    else if (it.kind === 'checkbox') out += renderCheckbox(it);
    // space and def render nothing
  }
  return out;
}

// ============================ block: blockquote ============================
function tryBlockquote(src, ctx) {
  const t = BLOCKQUOTE_RE.exec(src);
  if (!t) return null;
  let n = stripTail(t[0], '\n').split('\n');
  let rawAcc = '', textAcc = '', tokens = [];
  while (n.length > 0) {
    let i = false, l = [], p;
    for (p = 0; p < n.length; p++) {
      if (/^ {0,3}>/.test(n[p])) { l.push(n[p]); i = true; }
      else if (!i) l.push(n[p]);
      else break;
    }
    n = n.slice(p);
    const h = l.join('\n');
    const u = h.replace(/^( {0,3}>)([ \t]+)/gm, (g, b, m) => b + expandTabs(m, b.length))
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
    rawAcc = rawAcc ? rawAcc + '\n' + h : h;
    textAcc = textAcc ? textAcc + '\n' + u : u;
    const savedTop = ctx.top;
    ctx.top = true;
    blockTokens(u, ctx, tokens, true);
    ctx.top = savedTop;
    if (n.length === 0) break;
    const k = tokens[tokens.length - 1];
    if (!k) break;
    if (k.kind === 'code' || k.kind === 'heading' || k.kind === 'hr' || k.kind === 'html' || k.kind === 'table') break;
    if (k.kind === 'blockquote') {
      const g = k;
      const b = n.join('\n');
      const m = g.raw + '\n' + b.replace(/^ {0,3}>[ \t]?/gm, '');
      const f = tryBlockquote(m, ctx);
      if (!f) break;
      tokens[tokens.length - 1] = f;
      const y = m.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? n.slice(0, -R) : n;
      if (A.length > 0) rawAcc += '\n' + A.join('\n');
      textAcc = textAcc.substring(0, textAcc.length - g.text.length) + f.text;
      n = n.slice(A.length);
      if (n.length > 0 && /^ {0,3}>/.test(n[0])) continue;
      break;
    } else if (k.kind === 'list') {
      const g = k;
      const b = g.raw + '\n' + n.join('\n');
      const m = tryList(b, ctx);
      if (!m) break;
      tokens[tokens.length - 1] = m;
      const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = n.slice(0, f).join('\n');
        rawAcc += '\n' + y;
        textAcc += '\n' + y;
      }
      n = n.slice(f);
      continue;
    }
    // Otherwise the next chunk continues lazily.
  }
  return { kind: 'blockquote', raw: rawAcc, tokens, text: textAcc };
}

// ============================ block: list ============================
// Index of the first non-space character (-1 when the string is all
// spaces), mirroring `/[^ ]/` search semantics.
function firstNonSpace(s) {
  let k = 0;
  while (s.charCodeAt(k) === 32) k++;
  return k >= s.length ? -1 : k;
}

function listItemRegex(marker) {
  return new RegExp(`^( {0,3}${marker})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
}

// First line of a string, without allocating an array.
function firstLine(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

function tryList(src, ctx) {
  const t = LIST_START_RE.exec(src);
  if (!t) return null;
  const n = src;
  const r = t[1].trim();
  const ordered = r.length > 1;
  const list = { kind: 'list', raw: '', ordered, start: ordered ? +r.slice(0, -1) : '', loose: false, items: [] };
  const marker = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const itemRe = listItemRegex(marker);
  let p = false;
  let e = src;
  while (e) {
    let u = false, d = '';
    const it = itemRe.exec(e);
    if (!it || HR_RE.test(e)) break;
    const k = n.length - e.length;
    e = e.substring(it[0].length);
    const g = firstLine(it[2]);
    const b = it[1].length;
    // Expand the leading whitespace run only when it contains a tab;
    // otherwise the line is unchanged.
    let m = g;
    {
      let k = 0;
      while (g[k] === ' ' || g[k] === '\t') k++;
      if (k > 0 && g.slice(0, k).indexOf('\t') !== -1) m = expandTabs(g.slice(0, k), b) + g.slice(k);
    }
    let f = firstLine(e);
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = leadSpaces(m);
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    if (y && BLANK_LINE_RE.test(f)) { e = e.substring(f.length + 1); u = true; }
    if (!u) {
      const v = nextBulletRegex(R), Q = hrRegex(R), ee = fencesBeginRegex(R),
        te = headingBeginRegex(R), M = htmlBeginRegex(R), ne = blockquoteBeginRegex(R);
      const cap = indentCap(R);
      while (e) {
        const U = firstLine(e);
        let Z;
        f = U;
        {
          let k = 0;
          while (f[k] === ' ' || f[k] === '\t') k++;
          Z = (k > 0 && f.slice(0, k).indexOf('\t') !== -1) ? expandTabs(f.slice(0, k), 0) + f.slice(k) : f;
        }
        const sp = leadSpaces(Z);
        const allBlank = sp >= Z.length;
        // The six begin-patterns only match a line whose indent is at
        // most `cap` and whose first marker character is one of these.
        let isBegin = false;
        if (sp <= cap) {
          const ch = Z[sp];
          if (ch === '`' || ch === '~' || ch === '#' || ch === '<' || ch === '>' ||
              ch === '*' || ch === '+' || ch === '-' || ch === '_' ||
              (ch >= '0' && ch <= '9')) {
            isBegin = ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f);
          }
        }
        if (isBegin) break;
        if (sp >= R || allBlank) d += '\n' + Z.slice(R);
        else {
          if (y || firstNonSpace(m) >= 4 || ee.test(m) || te.test(m) || M.test(m) || Q.test(m)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && LHEADING_RE.test(m + '\n' + f) ? '    ' + Z.replace(/^ {0,3}/, '') : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = n.slice(k, n.length - e.length);
    if (!list.loose) {
      if (p) list.loose = true;
      else if (DOUBLE_BLANK_RE.test(A)) p = true;
    }
    list.items.push({ kind: 'list_item', raw: A, task: LIST_IS_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const h = list.items[list.items.length - 1];
  if (!h) return null;
  h.raw = h.raw.trimEnd();
  h.text = h.text.trimEnd();
  list.raw = n.slice(0, n.length - e.length).trimEnd();
  for (const u of list.items) {
    ctx.top = false;
    u.tokens = blockTokens(u.text, ctx, [], false);
    if (!list.loose) {
      const spaces = u.tokens.filter((g) => g.kind === 'space');
      if (spaces.length > 0 && spaces.some((g) => /\n.*\n/.test(g.raw))) list.loose = true;
    }
  }
  for (const u of list.items) {
    const d0 = u.tokens[0];
    if (u.task && d0 && (d0.kind === 'text' || d0.kind === 'para')) {
      u.text = u.text.replace(LIST_REPLACE_TASK, '');
      d0.raw = d0.raw.replace(LIST_REPLACE_TASK, '');
      d0.src = d0.src.replace(LIST_REPLACE_TASK, '');
      const kk = LIST_TASK_CHECKBOX.exec(u.raw);
      if (kk) {
        const g = { raw: kk[0] + ' ', checked: kk[0] !== '[ ]' };
        u.checked = g.checked;
        if (list.loose) {
          if (d0.kind === 'para' || d0.kind === 'text') d0.prefixHtml = renderCheckbox(g);
          else u.tokens.unshift({ kind: 'para', raw: g.raw, src: '', prefixHtml: renderCheckbox(g) });
        } else {
          u.tokens.unshift({ kind: 'checkbox', raw: g.raw, checked: g.checked });
        }
      }
    } else if (u.task) u.task = false;
  }
  if (list.loose) {
    for (const u of list.items) {
      u.loose = true;
      for (const d0 of u.tokens) if (d0.kind === 'text') d0.kind = 'para';
    }
  }
  return list;
}

// ============================ block: driver ============================
function blockTokens(src, ctx, items, cont) {
  let s = Infinity;
  let e = src;
  while (e) {
    if (e.length < s) s = e.length;
    else break;
    let r;
    if ((r = trySpace(e))) {
      e = e.substring(r.raw.length);
      const i = items[items.length - 1];
      if (r.raw.length === 1 && i !== undefined) i.raw += '\n';
      else items.push({ kind: 'space', raw: r.raw });
      continue;
    }
    if ((r = tryCode(e))) {
      e = e.substring(r.raw.length);
      const i = items[items.length - 1];
      if (i && (i.kind === 'para' || i.kind === 'text')) {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.src += '\n' + r.text;
      } else items.push(r);
      continue;
    }
    if ((r = tryFences(e))) { e = e.substring(r.raw.length); items.push(r); continue; }
    if ((r = tryHeading(e))) { e = e.substring(r.raw.length); items.push(r); continue; }
    if ((r = tryHr(e))) { e = e.substring(r.raw.length); items.push(r); continue; }
    if ((r = tryBlockquote(e, ctx))) { e = e.substring(r.raw.length); items.push(r); continue; }
    if ((r = tryList(e, ctx))) { e = e.substring(r.raw.length); items.push(r); continue; }
    if ((r = tryHtml(e))) { e = e.substring(r.raw.length); items.push(r); continue; }
    if ((r = tryDef(e))) {
      e = e.substring(r.raw.length);
      const i = items[items.length - 1];
      if (i && (i.kind === 'para' || i.kind === 'text')) {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.src += '\n' + r.raw;
      } else {
        if (!ctx.links.has(r.tag)) ctx.links.set(r.tag, { href: r.href, title: r.title });
        items.push(r);
      }
      continue;
    }
    if ((r = tryTable(e))) { e = e.substring(r.raw.length); items.push(r); continue; }
    if ((r = tryLheading(e))) { e = e.substring(r.raw.length); items.push(r); continue; }
    if (ctx.top && (r = tryParagraph(e))) {
      const i = items[items.length - 1];
      if (cont && i && i.kind === 'para') {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.src += '\n' + r.src;
      } else items.push(r);
      cont = false;
      e = e.substring(r.raw.length);
      continue;
    }
    if ((r = tryText(e))) {
      e = e.substring(r.raw.length);
      const i = items[items.length - 1];
      if (i && i.kind === 'text') {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.src += '\n' + r.src;
      } else items.push(r);
      continue;
    }
    break;
  }
  ctx.top = true;
  return items;
}

// ============================ entry point ============================
export function parse(md) {
  const ctx = {
    links: new Map(),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
  const src = String(md).replace(/\r\n|\r/g, '\n');
  const items = blockTokens(src, ctx, [], false);
  return renderBlocks(items, ctx);
}
