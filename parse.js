// marked-fast: a fast, dependency-free Markdown renderer whose parse(markdown)
// returns exactly the HTML that marked 18.1.3 renders with its default options
// (GitHub Flavored Markdown on, async off). Written from scratch: a single-pass
// block scanner plus a single-pass inline scanner that renders straight into
// an output array, with no token tree and no regular-expression dispatch in
// the hot paths. Where marked departs from the CommonMark/GFM spec, marked's
// output is the target, never the spec's.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Fast test for "does this chunk need escaping at all".
const NEED_ESC = /[&<>\"']/;
// Numeric character reference: &#65; &#x41; (1-7 decimal / 1-6 hex digits).
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g;
// Escape &, <, >, ", ' -- but leave a valid entity reference (&name; &#1; &#x1;) alone.
const ESC_NO_ENCODE = /[<>\"']|&(?!(?:#\d{1,7}|#[Xx][A-Fa-f0-9]{1,6}|\w+);)/g;
const ESC_ENCODE = /[&<>\"']/g;

// Escape a run of plain text the way marked does: numeric character references
// are decoded first (out of range / zero / surrogate -> U+FFFD, 38 -> &amp;),
// then & < > " ' are escaped, except an & that starts a valid entity reference.
function escText(s) {
  if (!NEED_ESC.test(s)) return s;
  NUM_REF.lastIndex = 0;
  if (NUM_REF.test(s)) {
    NUM_REF.lastIndex = 0;
    s = s.replace(NUM_REF, (m, d, h) => {
      const cp = h !== undefined ? parseInt(h, 16) : parseInt(d, 10);
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      if (cp === 38) return '&amp;';
      return String.fromCodePoint(cp);
    });
  }
  return s.replace(ESC_NO_ENCODE, (c) => ESC_MAP[c]);
}

// Escape an attribute value (href, title, alt, src): escape < > " ' and
// & only when it does not start a valid entity reference (marked keeps
// &copy; and &#65; as-is in attributes).
function escAttr(s) {
  if (!NEED_ESC.test(s)) return s;
  return s.replace(ESC_NO_ENCODE, (c) => ESC_MAP[c]);
}

// Escape a code span or code block: every & < > " ' is escaped.
function escCode(s) {
  if (!NEED_ESC.test(s)) return s;
  return s.replace(ESC_ENCODE, (c) => ESC_MAP[c]);
}

// ASCII punctuation (for backslash escapes): !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isAsciiPunct(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

// Unicode punctuation-or-symbol (marked's flanking test): \p{P} or \p{S}.
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCh(ch) {
  return PUNCT_RE.test(ch);
}

// Unicode whitespace (for flanking tests).
const SPACE_RE = /\s/;
function isSpaceCh(ch) {
  return SPACE_RE.test(ch);
}

// Normalize a link label the way marked does: trim, collapse inner whitespace
// to one space, then lower-upper-lower case folding.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Clean a link destination the way marked does: encodeURI, then turn %25 back
// into %. Returns null when encodeURI throws (lone surrogates).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inline scanner
// ---------------------------------------------------------------------------

// Characters that can appear in a bare-email local part.
function isEmailLocalCh(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || code === 46 || code === 33 || code === 35 ||
    code === 36 || code === 37 || code === 38 || code === 39 || code === 42 ||
    code === 43 || code === 47 || code === 61 || code === 63 || code === 94 ||
    code === 95 || code === 96 || code === 123 || code === 124 || code === 125 ||
    code === 126 || code === 45;
}

// Characters that can appear in a bare-email domain label.
function isEmailDomainCh(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || code === 45 || code === 95;
}

// Try to match a bare email starting at i. Returns the end index (exclusive)
// or -1. The email must have a dot in the domain, the last domain label must
// end with an alphanumeric, and the char after must not be a word char or '-'.
// `allowTrailingUnderscore`: true when an '_' emphasis opener is
// currently open in the inline delimiter stack, so a trailing '_' run
// after the domain may be that span's closing delimiter (and the email
// ends before it). Without an open '_', a trailing '_' is literal text
// and the email must not match (gfm-632: `a.b-c_d@a.b_` stays plain).
function matchEmail(s, i, n, allowTrailingUnderscore) {
  let j = i;
  while (j < n && isEmailLocalCh(s.charCodeAt(j))) j++;
  if (j === i || j >= n || s[j] !== '@') return -1;
  // Domain: label(.label)+ where each label starts with alnum and ends alnum.
  let k = j + 1;
  if (k >= n || !isEmailDomainCh(s.charCodeAt(k))) return -1;
  let dots = 0;
  let labelStart = k;
  let lastAlnum = -1;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 46) { // '.'
      // The label before the dot must end with an alnum.
      if (lastAlnum !== k - 1) return -1;
      // A dot not followed by a valid label char ends the match here
      // (a trailing dot is left as literal text).
      if (k + 1 >= n || !isEmailDomainCh(s.charCodeAt(k + 1))) break;
      dots++;
      k++;
      labelStart = k;
      lastAlnum = -1;
    } else if (isEmailDomainCh(c)) {
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) lastAlnum = k;
      k++;
    } else break;
  }
  if (dots < 1) return -1;
  if (lastAlnum !== k - 1) {
    // The domain scan consumed trailing '_' chars. Those are the
    // closing emphasis delimiter of a span the email sits inside
    // (`__...because@mark.example.com__`): marked extracts the span
    // text first, so the email never sees the '__'. Backtrack to the
    // last alnum and accept the email when the '_' run is followed by
    // a non-word char (i.e. it cannot be part of a longer domain).
    if (lastAlnum < 0) return -1;
    if (!allowTrailingUnderscore) return -1;
    const bk = lastAlnum + 1;
    let r = bk;
    while (r < n && s.charCodeAt(r) === 95) r++;
    if (r === bk) return -1;
    if (r < n) {
      const c = s.charCodeAt(r);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
          c === 95 || c === 45) return -1;
    }
    return bk;
  }
  // The char after must not be a word char or '-'.
  if (k < n) {
    const c = s.charCodeAt(k);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        c === 95 || c === 45) return -1;
  }
  return k;
}

// The _backpedal trim for a bare URL: drop trailing punctuation
// (? ! . , : ; * _ ' " ~ and unbalanced )) and a trailing &entity;.
// Applied repeatedly until stable (marked loops it).
const TRAIL_PUNCT = new Set([63, 33, 46, 44, 58, 59, 42, 95, 39, 34, 126, 41]);
function backpedalOnce(u) {
  const n = u.length;
  let i = 0;
  while (i < n) {
    const c = u.charCodeAt(i);
    if (c === 40) { // '(' -- need a balanced group \([^)]*\)
      const j = u.indexOf(')', i + 1);
      if (j === -1) break;
      i = j + 1;
    } else if (c === 38) { // '&' -- kept unless it starts a trailing entity
      let k = i + 1;
      while (k < n) {
        const d = u.charCodeAt(k);
        if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122)) k++;
        else break;
      }
      if (k > i + 1 && k < n && u.charCodeAt(k) === 59 && k === n - 1) break;
      i++;
    } else if (TRAIL_PUNCT.has(c)) {
      let j = i;
      while (j < n && TRAIL_PUNCT.has(u.charCodeAt(j))) j++;
      if (j === n) break;
      i = j;
    } else {
      let j = i;
      while (j < n) {
        const d = u.charCodeAt(j);
        if (d === 40 || d === 38 || TRAIL_PUNCT.has(d)) break;
        j++;
      }
      i = j;
    }
  }
  return u.slice(0, i);
}
function backpedalUrl(u) {
  let prev;
  do { prev = u; u = backpedalOnce(u); } while (u !== prev);
  return u;
}

// Try to match a bare URL / email / scheme autolink at position i.
// Returns {href, text, end} or null. `prevCh` is the char before i (for the
// www. lookbehind: the char before www. must be whitespace, *, _, ~, ( or
// start-of-string).
function matchBareUrl(s, i, n, prevCh, allowTrailingUnderscore) {
  // mailto: / xmpp: + email (scheme case-insensitive).
  const head7 = s.slice(i, i + 7).toLowerCase();
  if (head7 === 'mailto:' || head7.slice(0, 5) === 'xmpp:') {
    const isXmpp = head7.slice(0, 5) === 'xmpp:';
    const schemeLen = isXmpp ? 5 : 7;
    const e = matchEmail(s, i + schemeLen, n, allowTrailingUnderscore);
    if (e !== -1) {
      let end = e;
      // xmpp: may have one /resource suffix: /[A-Za-z0-9@.]+
      if (isXmpp && end < n && s[end] === '/') {
        let k = end + 1;
        while (k < n) {
          const c = s.charCodeAt(k);
          if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
              c === 64 || c === 46) k++;
          else break;
        }
        if (k > end + 1) end = k;
      }
      const text = s.slice(i, end);
      return { href: text, text, end };
    }
    return null;
  }
  // scheme:// URLs (http, https, ftp) -- no lookbehind. The scheme is
  // case-insensitive in the GFM url regex, so any mix (Https://, hTTp://)
  // counts (doc-01/doc-12).
  let schemeEnd = -1;
  {
    const m = /^(?:https?|ftp):\/\//i.exec(s.slice(i, i + 8));
    if (m) schemeEnd = i + m[0].length;
  }
  if (schemeEnd !== -1) {
    let j = schemeEnd;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 60) break;
      j++;
    }
    if (j === schemeEnd) return null;
    const raw = backpedalUrl(s.slice(i, j));
    if (!raw) return null;
    return { href: raw, text: raw, end: i + raw.length };
  }
  // www. -- needs the lookbehind.
  if (s.startsWith('www.', i)) {
    const ok = prevCh === undefined || prevCh === ' ' || prevCh === '\t' || prevCh === '\n' ||
      prevCh === '*' || prevCh === '_' || prevCh === '~' || prevCh === '(';
    if (!ok) return null;
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 60) break;
      j++;
    }
    const raw = backpedalUrl(s.slice(i, j));
    if (!raw) return null;
    return { href: 'http://' + raw, text: raw, end: i + raw.length };
  }
  // Bare email.
  const e = matchEmail(s, i, n, allowTrailingUnderscore);
  if (e !== -1) {
    const text = s.slice(i, e);
    return { href: 'mailto:' + text, text, end: e };
  }
  return null;
}

// Try to match an autolink <...> at position i. Returns {href, text, end}
// or null. The scheme is 2-32 chars; the email form needs a dot in the domain.
function matchAutolink(s, i, n) {
  if (s[i] !== '<') return null;
  const gt = s.indexOf('>', i + 1);
  if (gt === -1) return null;
  const inner = s.slice(i + 1, gt);
  if (inner.length === 0) return null;
  if (inner.indexOf(' ') !== -1 || inner.indexOf('\n') !== -1 || inner.indexOf('<') !== -1) return null;
  const colon = inner.indexOf(':');
  if (colon > 0) {
    // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}
    if (colon >= 2 && colon <= 32) {
      let ok = true;
      const c0 = inner.charCodeAt(0);
      if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) ok = false;
      for (let k = 1; ok && k < colon; k++) {
        const c = inner.charCodeAt(k);
        if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
              c === 43 || c === 46 || c === 45)) ok = false;
      }
      if (ok) return { href: inner, text: inner, end: gt + 1 };
    }
    return null;
  }
  // Email form.
  const at = inner.indexOf('@');
  if (at > 0) {
    const e = matchEmail(inner, 0, inner.length);
    if (e === inner.length) return { href: 'mailto:' + inner, text: inner, end: gt + 1 };
  }
  return null;
}

// Try to match an inline HTML tag at position i. Returns the end index
// (exclusive) or -1. The tag is returned verbatim.
function matchTag(s, i, n) {
  if (s[i] !== '<') return -1;
  // Comment: <!-- (-?> | ... -->)
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    const end = s.indexOf('-->', i + 4);
    if (end === -1) return -1;
    return end + 3;
  }
  // Processing instruction: <? ... ?>
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return -1;
    return end + 2;
  }
  // CDATA: <![CDATA[ ... ]]>
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    if (end === -1) return -1;
    return end + 3;
  }
  // Declaration: <!Letter ... > (needs whitespace after the letters)
  if (s.startsWith('<!', i)) {
    let j = i + 2;
    if (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
        while (j < n) {
          const d = s.charCodeAt(j);
          if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) j++;
          else break;
        }
        if (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) {
          const gt = s.indexOf('>', j);
          if (gt !== -1) return gt + 1;
        }
      }
    }
    return -1;
  }
  // Closing tag: </letter...>
  if (s.startsWith('</', i)) {
    let j = i + 2;
    if (j >= n) return -1;
    const c = s.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return -1;
    j++;
    while (j < n) {
      const d = s.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) j++;
      else break;
    }
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === '>') return j + 1;
    return -1;
  }
  // Opening tag: <letter...>
  let j = i + 1;
  if (j >= n) return -1;
  let c = s.charCodeAt(j);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return -1;
  j++;
  while (j < n) {
    const d = s.charCodeAt(j);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) j++;
    else break;
  }
  // Attributes: whitespace + name + optional =value (quoted or unquoted).
  while (j < n) {
    if (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r') {
      let k = j;
      while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
      if (k < n && s[k] === '>') return k + 1;
      if (k < n && s[k] === '/' && k + 1 < n && s[k + 1] === '>') return k + 2;
      // Attribute name must start with a letter, _ or :
      if (k >= n) return -1;
      const a0 = s.charCodeAt(k);
      if (!((a0 >= 65 && a0 <= 90) || (a0 >= 97 && a0 <= 122) || a0 === 95 || a0 === 58)) return -1;
      k++;
      while (k < n) {
        const d = s.charCodeAt(k);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) ||
            d === 95 || d === 58 || d === 46 || d === 45) k++;
        else break;
      }
      // Optional = value
      let m = k;
      while (m < n && (s[m] === ' ' || s[m] === '\t')) m++;
      if (m < n && s[m] === '=') {
        m++;
        while (m < n && (s[m] === ' ' || s[m] === '\t')) m++;
        if (m < n && s[m] === '"') {
          const q = s.indexOf('"', m + 1);
          if (q === -1) return -1;
          k = q + 1;
        } else if (m < n && s[m] === "'") {
          const q = s.indexOf("'", m + 1);
          if (q === -1) return -1;
          k = q + 1;
        } else {
          let v = m;
          while (v < n) {
            const d = s.charCodeAt(v);
            if (d === 32 || d === 9 || d === 10 || d === 13 || d === 34 || d === 39 ||
                d === 61 || d === 60 || d === 62 || d === 96) break;
            v++;
          }
          if (v === m) return -1;
          k = v;
        }
      }
      j = k;
    } else if (s[j] === '>') return j + 1;
    else if (s[j] === '/' && j + 1 < n && s[j + 1] === '>') return j + 2;
    else return -1;
  }
  return -1;
}

// Try to match a code span at position i. Returns {html, end} or null.
// The opening run is maximal (all consecutive backticks); the closing run
// must have exactly the same length.
function matchCodeSpan(s, i, n, textMode) {
  if (s[i] !== '`') return null;
  let openLen = 0;
  while (i + openLen < n && s[i + openLen] === '`') openLen++;
  const close = '`'.repeat(openLen);
  // Find the next occurrence of a run of exactly openLen backticks.
  let j = i + openLen;
  while (j < n) {
    if (s[j] === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      if (k - j === openLen) {
        let content = s.slice(i + openLen, j);
        // Newlines become spaces.
        if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
        // Strip one leading and one trailing space when both exist and
        // the content is not all spaces.
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' &&
            content.trim() !== '') {
          content = content.slice(1, -1);
        }
        if (textMode) return { html: escCode(content), end: k };
        return { html: '<code>' + escCode(content) + '</code>', end: k };
      }
      j = k;
    } else j++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Link / image matching
// ---------------------------------------------------------------------------

// Skip a code span starting at i (backtick run). Returns the index just past
// the closing run, or -1 when there is no matching close.
function skipCodeSpan(s, i, n) {
  let openLen = 0;
  while (i + openLen < n && s[i + openLen] === '`') openLen++;
  let j = i + openLen;
  while (j < n) {
    if (s[j] === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      if (k - j === openLen) return k;
      j = k;
    } else j++;
  }
  return -1;
}

// Skip a code span inside a LINK LABEL, following marked's label regex
// (`re`): `` `+(?!`)[^`]*?`+(?!`) `` -- the opener run, then content
// with NO backtick, then a closer run of ANY length (no backreference:
// the closer need not equal the opener). So `` `` a ` `` matches as a
// span (content ` a `), but `` `` a ` b `` `` does NOT match as one span:
// after `` `` a ` `` the leftover `` `` `` before ` in uses]` has no
// closer, so the whole label fails and the link is rejected (doc-22).
// A backtick run immediately before a ] that closes the label is NOT a
// code-span opener: marked's label regex has the `` ``+(?=\]) ``
// alternative, and its non-greedy star prefers the shorter label, so
// `[less `` a ` b ``](./docs/value.md)` closes at the first ] instead
// of spanning a huge code span to the ` of `a_b` (doc-33). Returns the
// index after the closer run, or -1 if there is no closer.
function skipLabelCodeSpan(s, i, n) {
  let j = i;
  while (j < n && s[j] === '`') j++;
  // A run of 2+ backticks immediately before a ] that closes the label
  // (followed by an inline `(` destination) is NOT a code span opener:
  // marked's label regex has the `` ``+(?=\]) `` alternative (2+
  // backticks), and its non-greedy star prefers the shorter label, so
  // `[less `` a ` b ``](./docs/value.md)` closes at the first ] instead
  // of spanning a huge code span to the ` of `a_b` (doc-33). A single
  // backtick before ] (cm-525: `[foo`](/uri)`) does NOT match that
  // alternative, so the code span `` `](/uri)` `` still forms.
  if (j - i >= 2 && j < n && s[j] === ']' && s[j + 1] === '(') return -1;
  // Content: no backtick allowed; the closer is the FIRST backtick run.
  let k = j;
  while (k < n && s[k] !== '`') k++;
  if (k >= n) return -1;
  let e = k;
  while (e < n && s[e] === '`') e++;
  return e;
}

// Match a nested bracket pair [ ... ] whose content has no further
// brackets (marked's `brackets` / Le). Returns the index after the
// closing ] or -1.
function matchNestedBracket(s, i) {
  const n = s.length;
  if (s[i] !== '[') return -1;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === ']') return j + 1;
    if (c === '[') return -1;
    j++;
  }
  return -1;
}

// Match a bracketed group [ ... ] whose content may contain one level of
// nested bracket pairs (marked's label atom). Returns the index after the
// closing ] or -1.
function matchBracketGroup(s, i) {
  const n = s.length;
  if (s[i] !== '[') return -1;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      const end = skipLabelCodeSpan(s, j, n);
      if (end !== -1) { j = end; continue; }
      // No closer: the label survives only if the backtick run is
      // immediately before the closing ] (`` ``+(?=\]) ``) -- which
      // requires TWO or more backticks. A single lone backtick before
      // ] cannot close the label (the single-char label atom excludes
      // backtick), so `[x `a ` b`](...)` is not a link (doc-16/20/
      // 23/35, cm-525 pattern).
      let k = j;
      while (k < n && s[k] === '`') k++;
      if (k - j >= 2 && k < n && s[k] === ']') return k + 1;
      return -1;
    }
    if (c === '[') {
      const end = matchNestedBracket(s, j);
      if (end !== -1) { j = end; continue; }
      return -1;
    }
    if (c === ']') return j + 1;
    j++;
  }
  return -1;
}

// Find the ] matching the [ at `start`, using marked's label-atom rules:
// the label is a sequence of atoms, and a bracketed group [...] (which may
// contain one level of nested [...]) is a single atom, so a ] inside such
// a group does not close the label. Returns the index of the matching ]
// or -1.
function findClosingBracket(s, start) {
  const n = s.length;
  let i = start + 1;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      const end = skipLabelCodeSpan(s, i, n);
      if (end !== -1) { i = end; continue; }
      // No closer: the label survives only if the backtick run is
      // immediately before the closing ] (`` ``+(?=\]) ``) -- which
      // requires TWO or more backticks. A single lone backtick before
      // ] cannot close the label (the single-char label atom excludes
      // backtick), so `[x `a ` b`](...)` is not a link (doc-16/20/
      // 23/35, cm-525 pattern).
      let k = i;
      while (k < n && s[k] === '`') k++;
      if (k - i >= 2 && k < n && s[k] === ']') return k;
      return -1;
    }
    if (c === '[') {
      const end = matchBracketGroup(s, i);
      if (end !== -1) { i = end; continue; }
      return -1;
    }
    if (c === ']') return i;
    i++;
  }
  return -1;
}

// Does this link text contain a nested inline link [x](...)? A nested
// reflink [x][y] does NOT count; a nested [x] followed by ( does. A
// nested IMAGE ![x](...) does not count either (its inner [...] is the
// image's own bracket, not a link).
function containsInlineLink(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      const end = skipCodeSpan(s, i, n);
      if (end !== -1) { i = end; continue; }
      i++;
      continue;
    }
    if (c === '!' && i + 1 < n && s[i + 1] === '[') {
      // Skip the whole image.
      const close = findClosingBracket(s, i + 1);
      if (close === -1) { i += 2; continue; }
      let j = close + 1;
      if (j < n && s[j] === '(') {
        // Skip the (...) destination (paren-depth aware).
        let depth = 0;
        while (j < n) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '(') depth++;
          else if (s[j] === ')') { depth--; if (depth === 0) { j++; break; } }
          j++;
        }
      } else if (j < n && s[j] === '[') {
        const c2 = findClosingBracket(s, j);
        if (c2 !== -1) j = c2 + 1;
      }
      i = j;
      continue;
    }
    if (c === '[') {
      const close = findClosingBracket(s, i);
      if (close !== -1) {
        if (close + 1 < n && s[close + 1] === '(') return true;
        if (containsInlineLink(s.slice(i + 1, close))) return true;
        i = close + 1;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return false;
}

// Resolve backslash escapes in a link destination: \ + ASCII punctuation
// becomes the punctuation itself.
function resolveDestEscapes(dest) {
  if (dest.indexOf('\\') === -1) return dest;
  let out = '';
  let i = 0;
  const n = dest.length;
  while (i < n) {
    const c = dest[i];
    if (c === '\\' && i + 1 < n && isAsciiPunct(dest.charCodeAt(i + 1))) {
      out += dest[i + 1];
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Is this a valid reference label (the `le` pattern)? Non-empty, not
// all-whitespace, no unescaped [ or ], no blank line inside.
function isValidRefLabel(text) {
  if (text.length === 0) return false;
  let hasNonSpace = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') { i += 2; hasNonSpace = true; continue; }
    if (c === '[' || c === ']') return false;
    if (c === '\n') {
      // A newline is allowed only when the next line is not blank.
      let j = i + 1;
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
      if (j >= n || text[j] === '\n') return false;
      i++;
      continue;
    }
    if (c !== ' ' && c !== '\t') hasNonSpace = true;
    i++;
  }
  return hasNonSpace;
}

// Parse the destination + optional title after the '(' of an inline link.
// `i` is the index just after '('. Returns {href, title, end} (end is the
// index just past the closing ')') or null.
function parseLinkDestination(s, i) {
  const n = s.length;
  // Skip spaces/tabs/newlines.
  let j = i;
  while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= n) return null;
  let href;
  let k;
  if (s[j] === ')') {
    // Empty destination.
    return { href: '', title: null, end: j + 1 };
  }
  if (s[j] === '<') {
    // Angle-bracket destination: <(?:\\.|[^\n<>\\])+>
    k = j + 1;
    let ok = false;
    while (k < n) {
      const c = s[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '\n' || c === '<' || c === '>') break;
      k++;
    }
    if (k < n && s[k] === '>') ok = true;
    if (!ok) return null;
    href = resolveDestEscapes(s.slice(j + 1, k));
    k++;
  } else {
    // Bare destination: paren-depth scan, escape-aware; ends at the first
    // space/tab/newline/control char or at the closing paren (depth -1).
    let depth = 0;
    k = j;
    let endKind = 0; // 1 = closed by ')', 2 = ended at whitespace
    while (k < n) {
      const c = s[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '(') { depth++; k++; continue; }
      if (c === ')') {
        depth--;
        if (depth < 0) { endKind = 1; break; }
        k++;
        continue;
      }
      const code = s.charCodeAt(k);
      if (code === 32 || code === 9 || code === 10 || code < 32) { endKind = 2; break; }
      k++;
    }
    if (endKind === 0) return null;
    href = resolveDestEscapes(s.slice(j, k));
    if (endKind === 1) return { href, title: null, end: k + 1 };
    // Ended at whitespace: parse an optional title, then expect ')'.
  }
  // Optional title after the destination (only when we ended at whitespace
  // or after an angle destination).
  let m = k;
  while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
  if (m < n && s[m] === ')') return { href, title: null, end: m + 1 };
  let title = null;
  if (m < n && (s[m] === '"' || s[m] === "'" || s[m] === '(')) {
    const open = s[m];
    const close = open === '(' ? ')' : open;
    let t = m + 1;
    let ok = false;
    while (t < n) {
      const c = s[t];
      if (c === '\\') { t += 2; continue; }
      if (c === close) { ok = true; break; }
      // A title in parens may not contain an unescaped '(' either.
      if (open === '(' && c === '(') break;
      t++;
    }
    if (!ok) return null;
    title = s.slice(m + 1, t);
    // Resolve backslash escapes in the title.
    if (title.indexOf('\\') !== -1) {
      let out = '';
      let p = 0;
      while (p < title.length) {
        if (title[p] === '\\' && p + 1 < title.length && isAsciiPunct(title.charCodeAt(p + 1))) {
          out += title[p + 1];
          p += 2;
        } else { out += title[p]; p++; }
      }
      title = out;
    }
    m = t + 1;
    while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
    if (m < n && s[m] === ')') return { href, title, end: m + 1 };
    return null;
  }
  return null;
}

// Try to match a link or image starting at the '[' at position i.
// `refs` maps normalized labels to {href, title}. Returns
// {href, title, text, end, isImage} or null. `isImage` is true when the
// caller saw a '!' just before i.
// Reject a link whose label contains a < that starts a tag or autolink
// which extends past the end of the label (marked's Be check). Such a
// tag would swallow the closing ] or the destination.
function labelHasSwallowingTag(s, labelStart, label) {
  if (!label.includes('<')) return false;
  const n = s.length;
  for (let p = 0; p < label.length; p++) {
    const c = label[p];
    if (c === '\\') { p++; continue; }
    if (c === '`') {
      const end = skipCodeSpan(label, p, label.length);
      if (end !== -1) { p = end - 1; continue; }
    }
    if (c !== '<') continue;
    const abs = labelStart + p;
    let end = matchTag(s, abs, n);
    if (end === -1) {
      const auto = matchAutolink(s, abs, n);
      if (auto) end = auto.end;
    }
    if (end !== -1) {
      if (end - abs > label.length - p) return true;
      p += end - abs - 1;
    }
  }
  return false;
}

function matchLink(s, i, refs, isImage) {
  const n = s.length;
  const close = findClosingBracket(s, i);
  if (close === -1) return null;
  const text = s.slice(i + 1, close);
  const after = close + 1;
  // A < starting a tag/autolink that swallows the ] rejects the link.
  if (labelHasSwallowingTag(s, i + 1, text)) return null;
  // Inline link: [text](dest "title")
  if (after < n && s[after] === '(') {
    if (!isImage && containsInlineLink(text)) return null;
    const dest = parseLinkDestination(s, after + 1);
    if (dest) {
      const href = cleanUrl(dest.href);
      if (href !== null) {
        return { href, title: dest.title, text, end: dest.end, isImage };
      }
    }
    // Not a valid inline link: fall back to the shortcut reference
    // [text], leaving the (...) as literal text.
    if (!isValidRefLabel(text)) return null;
    const skey = normalizeLabel(text);
    const sref = refs.get(skey);
    if (!sref) return null;
    if (!isImage && containsInlineLink(text)) return null;
    return { href: sref.href, title: sref.title, text, end: after, isImage };
  }
  // Full / collapsed reference: [text][label] or [text][]
  if (after < n && s[after] === '[') {
    const labelClose = s.indexOf(']', after + 1);
    if (labelClose === -1) return null;
    const rawLabel = s.slice(after + 1, labelClose);
    // The label may not contain [ or ] (unescaped) and may not be blank.
    let label = rawLabel;
    if (label.length === 0) label = text;
    if (!isValidRefLabel(rawLabel) && rawLabel.length !== 0) return null;
    if (rawLabel.length !== 0 && !isValidRefLabel(rawLabel)) return null;
    if (label.length === 0) return null;
    const key = normalizeLabel(label);
    const ref = refs.get(key);
    if (!ref) return null;
    if (!isImage && containsInlineLink(text)) return null;
    return { href: ref.href, title: ref.title, text, end: labelClose + 1, isImage };
  }
  // Shortcut reference: [text]
  if (!isValidRefLabel(text)) return null;
  const key = normalizeLabel(text);
  const ref = refs.get(key);
  if (!ref) return null;
  if (!isImage && containsInlineLink(text)) return null;
  return { href: ref.href, title: ref.title, text, end: after, isImage };
}

// ---------------------------------------------------------------------------
// Inline renderer (delimiter stack + single-pass scan)
// ---------------------------------------------------------------------------

// Compute left/right flanking for a delimiter run starting at i with length
// len in string s. The start/end of the string count as whitespace.
function flanking(s, i, len) {
  const n = s.length;
  const before = i > 0 ? s[i - 1] : '\n';
  const after = i + len < n ? s[i + len] : '\n';
  const beforeSpace = isSpaceCh(before);
  const afterSpace = isSpaceCh(after);
  const beforePunct = isPunctCh(before);
  const afterPunct = isPunctCh(after);
  const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return { left, right };
}

// Render an inline string to HTML (or to plain text when textMode is true,
// for image alt text). `refs` maps normalized labels to {href, title}.
// `st` tracks whether a link was emitted (marked's linkEmitted): a link
// whose text itself emits a link is rejected, so the flag is saved and
// restored around each link-text parse.
function inlineTo(s, refs, textMode, st) {
  if (!st) st = { linkEmitted: false };
  const n = s.length;
  const out = [];
  const delims = [];
  let i = 0;
  let textStart = 0;

  const flushText = (end) => {
    if (end > textStart) out.push(escText(s.slice(textStart, end)));
    textStart = end;
  };

  // Find the closest matching opener for `closer` in the delimiter stack.
  const findOpener = (closer) => {
    for (let d = delims.length - 1; d >= 0; d--) {
      const opener = delims[d];
      if (opener === closer) continue;
      if (opener.c !== closer.c) continue;
      if (!opener.open || !opener.active) continue;
      // Rule of 3: if either delimiter can both open and close, the sum
      // of the run lengths must not be a multiple of 3 unless both are.
      {
        const openerBoth = opener.open && opener.close;
        const closerBoth = closer.open && closer.close;
        if (openerBoth || closerBoth) {
          const sum = opener.n + closer.n;
          if (sum % 3 === 0 && (opener.n % 3 !== 0 || closer.n % 3 !== 0)) continue;
        }
      }
      return { opener, index: d };
    }
    return null;
  };

  // Try to resolve `closer` against openers in the stack, using up its
  // characters. Inserts the tags into `out` around the matched span.
  const resolveCloser = (closer) => {
    while (closer.n > 0) {
      const found = findOpener(closer);
      if (!found) break;
      const { opener, index } = found;
      const k = Math.min(opener.n, closer.n, 2);
      let openTag, closeTag;
      if (opener.c === '~') { openTag = '<del>'; closeTag = '</del>'; }
      else if (k === 2) { openTag = '<strong>'; closeTag = '</strong>'; }
      else { openTag = '<em>'; closeTag = '</em>'; }
      if (textMode) { openTag = ''; closeTag = ''; }
      const oi = out.indexOf(opener);
      const ci = out.indexOf(closer);
      // Delimiters stranded inside the span just formed can no longer
      // match a closer outside it (they would cross the span boundary).
      const stranded = delims.filter((d) => {
        const di = out.indexOf(d);
        return di > oi && di < ci;
      });
      if (openTag) out.splice(oi + 1, 0, openTag);
      if (closeTag) out.splice(ci + 1, 0, closeTag);
      for (const d of stranded) {
        const di = delims.indexOf(d);
        if (di !== -1) delims.splice(di, 1);
      }
      opener.n -= k;
      closer.n -= k;
      if (opener.n === 0) delims.splice(index, 1);
      // A _ opener that could also close is deactivated once it has been
      // used to open (it may not open again).
      if (opener.c === '_' && opener.close) opener.active = false;
    }
    if (closer.n === 0) {
      const di = delims.indexOf(closer);
      if (di !== -1) delims.splice(di, 1);
    }
  };

  while (i < n) {
    const c = s[i];

    // Backslash escape, or a backslash hard break.
    if (c === '\\') {
      if (i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) {
        flushText(i);
        out.push(escText(s[i + 1]));
        i += 2;
        textStart = i;
        continue;
      }
      if (i + 1 < n && s[i + 1] === '\n') {
        flushText(i);
        if (!textMode) out.push('<br>');
        i += 2;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // Newline: a soft break, or a hard break after 2+ trailing spaces.
    // A hard break consumes the trailing spaces and skips leading spaces
    // on the next line; a soft break keeps the spaces on both sides.
    if (c === '\n') {
      let k = i;
      while (k > textStart && s[k - 1] === ' ') k--;
      const spaces = i - k;
      if (spaces >= 2) {
        flushText(k);
        if (!textMode) out.push('<br>');
        i++;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        textStart = i;
      } else {
        flushText(i);
        out.push('\n');
        i++;
        textStart = i;
      }
      continue;
    }

    // Code span.
    if (c === '`') {
      const span = matchCodeSpan(s, i, n, textMode);
      if (span) {
        flushText(i);
        out.push(span.html);
        i = span.end;
        textStart = i;
        continue;
      }
      // No matching close: the whole run is literal text. Skip past
      // it so a shorter run inside it cannot start a span (cm-347).
      while (i < n && s[i] === '`') i++;
      continue;
    }

    // Link or image.
    if (c === '[' || (c === '!' && i + 1 < n && s[i + 1] === '[')) {
      const isImage = c === '!';
      const bracket = isImage ? i + 1 : i;
      const link = matchLink(s, bracket, refs, isImage);
      if (link) {
        // Parse the link text with a fresh linkEmitted flag. If the text
        // itself emits a link, the outer link is rejected (marked's De).
        // While parsing the text, inLink is set: bare URLs and autolinks
        // inside link text are plain text, not links (doc-12).
        // In textMode (alt text) the inner text is plain text too.
        const saved = st.linkEmitted;
        const savedInLink = st.inLink;
        st.linkEmitted = false;
        st.inLink = true;
        const inner = inlineTo(link.text, refs, textMode || isImage, st);
        const emitted = st.linkEmitted;
        st.linkEmitted = saved;
        st.inLink = savedInLink;
        if (!isImage && emitted) {
          // Nested link: the '[' is literal text; keep scanning.
          i++;
          continue;
        }
        flushText(i);
        if (textMode) {
          // Alt text: a link or image renders as just its text.
          out.push(inner);
        } else if (isImage) {
          let tag = '<img src="' + escAttr(link.href) + '" alt="' + escAttr(inner) + '"';
          if (link.title !== null && link.title !== undefined) {
            tag += ' title="' + escAttr(link.title) + '"';
          }
          tag += '>';
          out.push(tag);
        } else {
          let tag = '<a href="' + escAttr(link.href) + '"';
          if (link.title !== null && link.title !== undefined) {
            tag += ' title="' + escAttr(link.title) + '"';
          }
          tag += '>' + inner + '</a>';
          out.push(tag);
          st.linkEmitted = true;
        }
        i = link.end;
        textStart = i;
        continue;
      }
      // Not a link: the '[' (or '!') is literal text; keep scanning.
      i++;
      continue;
    }

    // Autolink <...> or inline HTML tag. Angle-bracket autolinks are
    // NOT suppressed inside link text (marked renders them nested,
    // doc-12); only bare URLs are suppressed by inLink.
    if (c === '<') {
      const auto = matchAutolink(s, i, n);
      if (auto) {
        flushText(i);
        const href = escAttr(cleanUrl(auto.href) ?? auto.href);
        if (textMode) {
          out.push(escText(auto.text));
        } else {
          out.push('<a href="' + href + '">' + escText(auto.text) + '</a>');
        }
        i = auto.end;
        textStart = i;
        continue;
      }
      const tagEnd = matchTag(s, i, n);
      if (tagEnd !== -1) {
        flushText(i);
        const tag = s.slice(i, tagEnd);
        // marked's tag(): an opening `<a ` (note the required space,
        // so `<a>` alone does not count) sets the document-level
        // inLink, `</a>` clears it; the state persists across the
        // whole document (the lexer state is never reset between
        // blocks), so an unclosed `<a />` suppresses all later bare
        // URLs (doc-06). Same for inRawBlock with pre/code/kbd/script.
        if (!st.inLink && /^<a /i.test(tag)) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(tag)) st.inLink = false;
        if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = false;
        out.push(textMode ? escAttr(tag) : tag);
        i = tagEnd;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // Delimiter run: *, _, ~.
    if (c === '*' || c === '_' || c === '~') {
      let len = 0;
      while (i + len < n && s[i + len] === c) len++;
      // A ~ run longer than 2 is not a delimiter at all.
      if (c === '~' && len > 2) {
        i += len;
        continue;
      }
      const { left, right } = flanking(s, i, len);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = left && (!right || isPunctCh(i > 0 ? s[i - 1] : '\n'));
        canClose = right && (!left || isPunctCh(i + len < n ? s[i + len] : '\n'));
      } else {
        canOpen = left;
        canClose = right;
      }
      if (!canOpen && !canClose) {
        i += len;
        continue;
      }
      flushText(i);
      const delim = { c, n: len, open: canOpen, close: canClose, active: true };
      out.push(delim);
      delims.push(delim);
      if (canClose) resolveCloser(delim);
      i += len;
      textStart = i;
      continue;
    }

    // Bare URL / email. Try the scheme/www forms at this position, and an
    // email when the char could start a local part.
    if (c === 'h' || c === 'f' || c === 'w' || c === 'm' || c === 'x' ||
        isEmailLocalCh(s.charCodeAt(i))) {
      const prevCh = i > 0 ? s[i - 1] : undefined;
      // Only try a bare URL at a position where it could start: for an
      // email, the previous char must not be an email-local char (the
      // local part starts here); for www., the lookbehind is checked
      // inside matchBareUrl; scheme URLs may start anywhere.
      const prevIsLocal = prevCh !== undefined && isEmailLocalCh(prevCh.charCodeAt(0));
      // Scheme start, case-insensitive (Https://, MAILTO:, ...).
      const cl = c.toLowerCase();
      const isSchemeStart = (cl === 'h' && /^(?:https?):\/\//i.test(s.slice(i, i + 8))) ||
        (cl === 'f' && /^ftp:\/\//i.test(s.slice(i, i + 6))) ||
        (cl === 'm' && /^mailto:/i.test(s.slice(i, i + 7))) ||
        (cl === 'x' && /^xmpp:/i.test(s.slice(i, i + 5)));
      if (!st.inLink && (isSchemeStart || (c === 'w' && s.startsWith('www.', i)) || !prevIsLocal)) {
        // An '_' emphasis opener is currently open: a trailing '_' run
        // after an email domain may be its closing delimiter.
        let hasUnderscoreOpener = false;
        for (let d = 0; d < delims.length; d++) {
          const dd = delims[d];
          if (dd.c === '_' && dd.open && dd.active) { hasUnderscoreOpener = true; break; }
        }
        const bare = matchBareUrl(s, i, n, prevCh, hasUnderscoreOpener);
        if (bare) {
          flushText(i);
          if (textMode) {
            out.push(escText(bare.text));
          } else {
            const href = escAttr(cleanUrl(bare.href) ?? bare.href);
            out.push('<a href="' + href + '">' + escText(bare.text) + '</a>');
          }
          i = bare.end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    i++;
  }

  flushText(n);
  // Render the output: strings stay, delimiter objects become their literal
  // remaining characters.
  let result = '';
  for (let k = 0; k < out.length; k++) {
    const item = out[k];
    if (typeof item === 'string') result += item;
    else result += item.c.repeat(item.n);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Block scanner
// ---------------------------------------------------------------------------

// Is this line blank (only spaces/tabs)?
function isBlankLine(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Leading indentation in columns (a tab advances to the next multiple of 4).
function indentOf(line) {
  let col = 0;
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) { col += 4 - (col % 4); k++; }
    else break;
  }
  return col;
}

// Strip up to `n` columns of leading indentation from a line (expanding a
// tab that straddles the boundary into spaces).
function stripIndent(line, n) {
  // Expand the leading whitespace run to spaces (tabs expand to the
  // next multiple of 4 from their original column), then strip n.
  // Expanding first is essential: a tab kept literally after stripping
  // would re-expand from the wrong column.
  let col = 0;
  let k = 0;
  let spaces = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === 32) { col++; spaces++; k++; }
    else if (c === 9) { const w = 4 - (col % 4); col += w; spaces += w; k++; }
    else break;
  }
  if (spaces <= n) return line.slice(k);
  return ' '.repeat(spaces - n) + line.slice(k);
}

// Strip exactly 4 columns of indent for an indented code block line.
// A tab that starts before column 4 always ends exactly at column 4,
// so it is consumed whole; a tab starting at column 4 or later is
// entirely beyond the indent and is preserved literally (doc-02:
// `    \tindented` keeps its tab, it does not become 4 spaces).
function stripCodeIndent(line) {
  let col = 0;
  let k = 0;
  while (k < line.length && col < 4) {
    const c = line.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) { col += 4 - (col % 4); k++; }
    else break;
  }
  return line.slice(k);
}

// The block-tag list (CommonMark type 6): used for html blocks and for the
// paragraph-interruption test.
const BLOCK_TAGS = new Set(('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul').split('|'));

// Does this line start a block-level HTML construct that interrupts a
// paragraph (types 1-6)? Type 7 (any other tag, e.g. <foo>, </span>,
// </pre>) does NOT interrupt a paragraph. `line` is the raw line.
function isHtmlBlockStart(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k > 3) return false;
  if (line[k] !== '<') return false;
  const rest = line.slice(k);
  // Type 1: an OPENING script/pre/style/textarea tag only.
  if (/^<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(rest)) return true;
  if (rest.startsWith('<!--')) return true;
  if (rest.startsWith('<?')) return true;
  if (/^<![A-Za-z]/.test(rest)) return true;
  if (rest.startsWith('<![CDATA[')) return true;
  // Type 6: a block tag (open or close).
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
    const after = rest.slice(m[0].length);
    if (after === '' || after[0] === ' ' || after[0] === '\t' || after[0] === '\n' ||
        after[0] === '>' || after.startsWith('/>')) return true;
  }
  return false;
}

// Does the line at index `li` start a table (header line + delimiter line)?
// This is the raw table regex, without the cell-count check: the paragraph
// interruption test uses it.
function isTableStart(lines, li) {
  if (li + 1 >= lines.length) return false;
  const header = lines[li];
  const delim = lines[li + 1];
  if (isBlankLine(header)) return false;
  // Header must not start with a space (the ^ * allows up to 3, but the
  // first non-space char must be non-space; a header starting with 4+
  // spaces is indented code, handled elsewhere).
  let h = 0;
  while (h < header.length && header[h] === ' ') h++;
  if (h > 3) return false;
  // Delimiter: {0,3} spaces, then cells of :?-+:? separated by |.
  let d = 0;
  while (d < delim.length && delim[d] === ' ') d++;
  if (d > 3) return false;
  const rest = delim.slice(d);
  if (!/^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(rest)) return false;
  // The delimiter must contain at least one |, and the header cell count
  // must equal the delimiter cell count.
  if (rest.indexOf('|') === -1) return false;
  const headerCells = splitTableRow(header);
  const delimCells = splitTableRow(rest);
  if (headerCells.length !== delimCells.length) return false;
  return true;
}

// Does this line start a block that interrupts a paragraph?
// (hr, ATX heading, blockquote, fences, list, html, table.)
// `inList` is true when the paragraph lives inside a list item's
// content. There, ANY ordered marker (1-9 digits) interrupts a
// paragraph and starts a nested list (doc-01: `505791.` after a
// paragraph inside an item becomes <ol start="505791">). At the top
// level and inside a blockquote only a marker starting with 1
// interrupts (probe: `foo\n505791. bar` stays one paragraph, as does
// `> foo\n> 505791. bar`).
function interruptsParagraph(lines, li, inList) {
  const line = lines[li];
  if (isBlankLine(line)) return true;
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k > 3) return false;
  const rest = line.slice(k);
  // hr: 3+ of -, _, * (with spaces between).
  if (/^(?:-[ \t]*){3,}$/.test(rest) || /^(?:_[ \t]*){3,}$/.test(rest) ||
      /^(?:\*[ \t]*){3,}$/.test(rest)) return true;
  // ATX heading.
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return true;
  // Blockquote.
  if (rest[0] === '>') return true;
  // Fences. A backtick fence's info string may not contain a
  // backtick, so ```bar``` is inline code, not a fence, and does
  // not interrupt a paragraph (doc-05).
  {
    const fm = /^(?:(`{3,})|(~{3,}))/.exec(rest);
    if (fm) {
      if (fm[2]) return true;
      if (rest.slice(fm[1].length).indexOf('`') === -1) return true;
    }
  }
  // List: a bullet interrupts a paragraph; an ordered marker interrupts
  // only when it starts with 1 (or any number inside a list item).
  // An EMPTY item (no content) cannot interrupt a paragraph.
  if (/^(?:[*+-])[ \t]+[^ \t\n]/.test(rest)) return true;
  {
    const om = /^(?:(\d{1,9})[.)])[ \t]+[^ \t\n]/.exec(rest);
    if (om && (inList || parseInt(om[1], 10) === 1)) return true;
  }
  // HTML block start.
  if (isHtmlBlockStart(line)) return true;
  // Table start.
  if (isTableStart(lines, li)) return true;
  return false;
}

// True when the line is a valid fenced-code opener: up to 3 spaces,
// 3+ backticks or tildes, and (for backticks) an info string with
// no backtick. A lazy line cannot continue a fence opener (doc-17:
// `` ```toml `` followed by an under-indented line ends the item
// and leaves the fence empty, it does not merge into the info).
function isFenceOpenerLine(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k > 3) return false;
  const ch = line[k];
  if (ch !== '`' && ch !== '~') return false;
  let flen = 0;
  while (k + flen < line.length && line[k + flen] === ch) flen++;
  if (flen < 3) return false;
  if (ch === '`' && line.slice(k + flen).indexOf('`') !== -1) return false;
  return true;
}

// Strip up to k columns of indent from a fenced-code content line.
// Tabs advance to the next multiple of 4; a tab that starts before
// the k boundary is consumed ENTIRELY even if it extends past k
// (probe: fence indent 3, content `\tindented tab` -> `indented tab`,
// not ` indented tab`). Spaces are stripped one column at a time.
function stripFenceIndent(line, k) {
  let col = 0, s = 0;
  while (s < line.length && col < k) {
    if (line[s] === ' ') { col++; s++; }
    else if (line[s] === '\t') { col = (col + 4) & ~3; s++; }
    else break;
  }
  return line.slice(s);
}

// True when the line is a thematic break (3+ of -, _, * with spaces).
function isHr(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k > 3) return false;
  const rest = line.slice(k).replace(/[ \t]+$/, '');
  return /^(?:-[ \t]*){3,}$/.test(rest) || /^(?:_[ \t]*){3,}$/.test(rest) ||
    /^(?:\*[ \t]*){3,}$/.test(rest);
}

// Parse blocks from `lines` starting at index `start` (inclusive) to `end`
// (exclusive). Appends rendered strings and inline-item objects to `out`.
// `refs` is the shared link-reference map (mutated by defs).
// An inline item is {s, pre, post}: parse s inline, wrap with pre/post.
function blockParse(lines, start, end, refs, out, isTop, inList) {
  let i = start;
  // True when a blank line separates two top-level blocks in this range
  // (used for list looseness; blank lines inside a nested block do not
  // count because they are consumed by that block's own parse).
  let blankBetween = false;
  let hadBlank = false;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) {
      if (out.length > 0) hadBlank = true;
      i++;
      continue;
    }
    if (hadBlank && out.length > 0) blankBetween = true;
    hadBlank = false;

    // Indented code: 4+ spaces (or a tab) of indent, and not a list item.
    {
      const ind = indentOf(line);
      if (ind >= 4) {
        // Collect the code lines (indented lines and blank lines).
        const code = [];
        let j = i;
        let lastNonBlank = -1;
        let lastCodeLine = i;
        while (j < end) {
          const l = lines[j];
          if (isBlankLine(l)) {
            // A blank line is part of the code block only when a later
            // indented line follows. A whitespace-only line keeps its
            // spaces (minus the 4-space code indent), it is not empty.
            let k = j + 1;
            while (k < end && isBlankLine(lines[k])) k++;
            if (k < end && indentOf(lines[k]) >= 4) {
              code.push(stripCodeIndent(l));
              j++;
              continue;
            }
            break;
          }
          if (indentOf(l) >= 4) {
            code.push(stripCodeIndent(l));
            lastNonBlank = code.length - 1;
            lastCodeLine = j;
            j++;
          } else break;
        }
        code.length = lastNonBlank + 1;
        // The content ends with a newline when the source has one after
        // the last code line.
        let content = code.join('\n');
        if (lastCodeLine < lines.length - 1) content += '\n';
        out.push('<pre><code>' + escCode(content) + '</code></pre>\n');
        i = j;
        continue;
      }
    }

    // Fenced code: ``` or ~~~.
    {
      let k = 0;
      while (k < line.length && line[k] === ' ') k++;
      if (k <= 3) {
        const fenceCh = line[k];
        if (fenceCh === '`' || fenceCh === '~') {
          let flen = 0;
          while (k + flen < line.length && line[k + flen] === fenceCh) flen++;
          if (flen >= 3) {
            const info = line.slice(k + flen).trim();
            // A backtick fence's info string may not contain a backtick.
            if (!(fenceCh === '`' && info.indexOf('`') !== -1)) {
              const code = [];
              let j = i + 1;
              let closed = false;
              while (j < end) {
                const l = lines[j];
                let m = 0;
                while (m < l.length && l[m] === ' ') m++;
                if (m <= 3 && l[m] === fenceCh) {
                  let clen = 0;
                  while (m + clen < l.length && l[m + clen] === fenceCh) clen++;
                  if (clen >= flen) {
                    // The rest of the closing line must be spaces only.
                    let t = m + clen;
                    let onlySpaces = true;
                    while (t < l.length) {
                      if (l[t] !== ' ' && l[t] !== '\t') { onlySpaces = false; break; }
                      t++;
                    }
                    if (onlySpaces) { closed = true; j++; break; }
                  }
                }
                code.push(l);
                j++;
              }
              // The info string's first word is the language; backslash
              // escapes in it are unescaped (cm-024: foo\+bar -> foo+bar).
              const lang = info.split(/[ \t]/, 1)[0].replace(/\\([!-/:-@\[-`{-~])/g, '$1');
              let tag = '<pre><code';
              if (lang) tag += ' class="language-' + escAttr(lang) + '"';
              // Dedent content lines by the opening fence's indent
              // (up to k columns each; a tab split by the boundary
              // is consumed whole -- stripFenceIndent). ONLY backtick
              // fences dedent: marked does NOT dedent tilde-fence
              // content (probe: `   ~~~ts` + `   aaa` -> `   aaa`,
              // while backtick -> `aaa`; doc-22/29).
              if (fenceCh === '`') {
                for (let t = 0; t < code.length; t++) {
                  code[t] = stripFenceIndent(code[t], k);
                }
              }
              // For an unclosed fence, a trailing '' in code is the
              // split artifact of a trailing newline, not a line.
              if (!closed && code.length > 0 && code[code.length - 1] === '') code.pop();
              // A fenced code block drops exactly one trailing real
              // blank line (probed: b+2 blanks -> b\n\n, b+1 -> b\n).
              if (code.length > 0 && code[code.length - 1] === '') code.pop();
              // Non-empty code always ends with one newline.
              let content = code.join('\n');
              if (code.length > 0) content += '\n';
              tag += '>' + escCode(content) + '</code></pre>\n';
              out.push(tag);
              i = j;
              continue;
            }
          }
        }
      }
    }

    // ATX heading.
    {
      let k = 0;
      while (k < line.length && line[k] === ' ') k++;
      if (k <= 3 && line[k] === '#') {
        let level = 0;
        while (k + level < line.length && line[k + level] === '#') level++;
        if (level >= 1 && level <= 6) {
          const after = line.slice(k + level);
          if (after === '' || after[0] === ' ' || after[0] === '\t') {
            let text = after.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            // Strip a closing sequence of #s (preceded by a space, or
            // the whole content when it is only #s, as in "### ###"),
            // then trim the spaces left before it.
            text = text.replace(/(?:^|[ \t])#+[ \t]*$/, '').replace(/[ \t]+$/, '');
            out.push({ s: text, pre: '<h' + level + '>', post: '</h' + level + '>\n' });
            i++;
            continue;
          }
        }
      }
    }

    // Horizontal rule.
    {
      let k = 0;
      while (k < line.length && line[k] === ' ') k++;
      if (k <= 3) {
        const rest = line.slice(k).replace(/[ \t]+$/, '');
        if (/^(?:-[ \t]*){3,}$/.test(rest) || /^(?:_[ \t]*){3,}$/.test(rest) ||
            /^(?:\*[ \t]*){3,}$/.test(rest)) {
          out.push('<hr>\n');
          i++;
          continue;
        }
      }
    }

    // Blockquote: lines starting with > (up to 3 spaces, then > and an
    // optional space), plus lazy continuation lines that belong to a
    // paragraph inside the quote.
    {
      let k = 0;
      while (k < line.length && line[k] === ' ') k++;
      if (k <= 3 && line[k] === '>') {
        const content = [];
        // The blockquote content indent (column where content starts).
        const contentIndent = k + 1 + (k + 1 < line.length && line[k + 1] === ' ' ? 1 : 0);
        let inFence = null;
        let j = i;
        while (j < end) {
          const l = lines[j];
          let m = 0;
          while (m < l.length && l[m] === ' ') m++;
          if (m <= 3 && l[m] === '>') {
            // Strip the marker: expand the whitespace after '>' to
            // spaces (tabs expand from the marker's column), then drop
            // exactly one space (marked's blockquoteMarkerWhitespace
            // + blockquoteSetextReplace2).
            let t = m + 1;
            let col = m + 1;
            let sp = 0;
            while (t < l.length && (l[t] === ' ' || l[t] === '\t')) {
              if (l[t] === ' ') { sp++; col++; t++; }
              else { const w = 4 - (col % 4); sp += w; col += w; t++; }
            }
            const cl = (sp >= 1 ? ' '.repeat(sp - 1) : '') + l.slice(t);
            // Track fenced code blocks inside the quote. A backtick
            // fence opener's info string may not contain a backtick,
            // so `` ```inner backticks``` `` is inline code, not a
            // fence (doc-05) -- it must not set inFence, or the lazy
            // lines that follow would wrongly end the quote.
            const fm = /^(?:`{3,}|~{3,})/.exec(cl);
            if (fm && !(fm[0][0] === '`' && cl.slice(fm[0].length).indexOf('`') !== -1)) {
              if (!inFence) inFence = fm[0][0];
              else if (fm[0][0] === inFence) inFence = null;
            }
            content.push(cl);
            j++;
            continue;
          }
          // Lazy continuation: only when the quote is inside a paragraph
          // (the last content line is not blank), the line is not a
          // block start, and we are not inside a fenced code block or
          // an indented code block (lazy lines cannot continue code).
          // The lazy line keeps its leading whitespace verbatim when
          // indented < 4 (`> foo\n bar` -> `foo\n bar`), but at indent
          // >= 4 the 4-column indented-code indent is stripped
          // (`> foo\n    - bar` -> `foo\n- bar`, cm-238). It is merged
          // into the previous content line, so it stays part of the
          // paragraph (it cannot start a new block).
          const last = content.length > 0 ? content[content.length - 1] : null;
          const lastIsCode = last !== null && indentOf(last) >= 4;
          if (content.length > 0 && !isBlankLine(last) && !inFence && !lastIsCode &&
              !interruptsParagraph(lines, j, inList)) {
            const stripped = l.replace(/^[ \t]+/, '');
            // A lazy setext underline is indented by 4 spaces so it is
            // paragraph text, not a heading underline (marked's
            // blockquoteSetextReplace).
            let merged = /^(?:=+|-+)[ \t]*$/.test(stripped) ? '    ' + stripped :
              (indentOf(l) >= 4 ? stripCodeIndent(l) : l);
            // A lazy line at indent >= 4 is indented CODE in marked's
            // inner parse, and a code block's text carries a trailing
            // newline when a line follows it (fuzz Pola 3B, same as
            // Pola 3A in lists): only the last of a run of such lines
            // gets it, and only when the quote continues after it.
            if (indentOf(l) >= 4 && !/^(?:=+|-+)[ \t]*$/.test(stripped)) {
              const nx = lines[j + 1];
              let nxIsQuote = false;
              if (j + 1 < end && !isBlankLine(nx)) {
                let k2 = 0;
                while (k2 < nx.length && nx[k2] === ' ') k2++;
                nxIsQuote = k2 <= 3 && nx[k2] === '>';
              }
              const nextIsCode = j + 1 < end && !isBlankLine(nx) && !nxIsQuote &&
                indentOf(nx) >= 4 && !interruptsParagraph(lines, j + 1, inList);
              const hasFollowing = j + 1 < end && !isBlankLine(nx);
              if (!nextIsCode && hasFollowing) merged += '\n';
            }
            content[content.length - 1] = last + '\n' + merged;
            j++;
            continue;
          }
          break;
        }
        // A trailing whitespace-only line (from a `>  ` line) at the end
        // of the quote belongs to the paragraph, not a blank separator.
        if (content.length >= 2) {
          const lastLine = content[content.length - 1];
          if (lastLine.length > 0 && /^[ \t]+$/.test(lastLine) &&
              !isBlankLine(content[content.length - 2])) {
            content[content.length - 2] += '\n' + lastLine;
            content.pop();
          }
        }
        // Preserve the trailing-newline info for nested code blocks.
        {
          let lastIdx = j - 1;
          while (lastIdx >= i && isBlankLine(lines[lastIdx])) lastIdx--;
          if (lastIdx >= i && lastIdx < lines.length - 1) content.push('');
        }
        const inner = [];
        blockParse(content, 0, content.length, refs, inner, false, inList);
        // Defer rendering: a def defined later in the document may be
        // referenced by inline content inside the quote.
        out.push({ kind: 'blockquote', inner });
        i = j;
        continue;
      }
    }

    // List.
    {
      const listInfo = matchListStart(line);
      if (listInfo) {
        const { ordered, bullet, delimiter, startNum, contentIndent, firstLine } = listInfo;
        const items = [];
        let j = i;
        let loose = false;
        let pendingBlank = false;
        while (j < end) {
          const l = lines[j];
          // A thematic break ends the list (it beats a list item
          // marker, as in "* * *").
          if (isHr(l)) break;
          const info = matchListStart(l);
          if (info && info.ordered === ordered &&
              (ordered ? info.delimiter === delimiter : info.bullet === bullet)) {
            // A new item.
            if (items.length > 0 && pendingBlank) loose = true;
            pendingBlank = false;
            const itemStart = j;
            const itemLines = [info.firstLine];
            j++;
            // Collect the item's continuation lines.
            while (j < end) {
              const cl = lines[j];
              if (isBlankLine(cl)) {
                // A blank line belongs to the item if a later line is
                // indented content or another item. Check for another
                // item first (a blank line between items keeps the
                // list going, loose); only then apply the rule that an
                // item with no content yet ends at a blank line.
                let k = j + 1;
                while (k < end && isBlankLine(lines[k])) k++;
                if (k < end) {
                  const ni = matchListStart(lines[k]);
                  // A marker is a new sibling item only when it is
                  // less indented than our content; at content indent
                  // or deeper it is nested content (doc-01).
                  if (ni && ni.ordered === ordered &&
                      (ordered ? ni.delimiter === delimiter : ni.bullet === bullet) &&
                      indentOf(lines[k]) < info.contentIndent) {
                    pendingBlank = true;
                    j = k;
                    break;
                  }
                }
                const hasContent = itemLines.some((x) => !isBlankLine(x));
                if (!hasContent) break;
                if (k < end && indentOf(lines[k]) >= info.contentIndent) {
                  itemLines.push('');
                  j++;
                  continue;
                }
                break;
              }
              const ni = matchListStart(cl);
              if (ni && ni.ordered === ordered &&
                  (ordered ? ni.delimiter === delimiter : ni.bullet === bullet)) {
                // A marker is a new item only if it is less indented
                // than our content; otherwise it is nested content.
                // (indent > 3 means it cannot be a sibling at all --
                // matchListStart returns null there -- so it falls
                // through to the lazy rule below.)
                if (indentOf(cl) < info.contentIndent && indentOf(cl) <= 3) break;
              }
              if (indentOf(cl) >= info.contentIndent) {
                itemLines.push(stripIndent(cl, info.contentIndent));
                j++;
                continue;
              }
              // Lazy continuation: the line is not indented content and
              // is not a new sibling item, but the item's paragraph is
              // open -- merge the stripped text into the paragraph so it
              // cannot start a new block. (A line that interrupts a
              // paragraph -- hr, heading, fence, ... -- or that is itself
              // a list item is not lazy.)
              {
                const lastItemLine = itemLines.length > 0 ? itemLines[itemLines.length - 1] : null;
                if (lastItemLine !== null && !isBlankLine(lastItemLine) &&
                    !isBlankLine(cl) && !interruptsParagraph(lines, j, inList) &&
                    !matchListStart(cl) && !isFenceOpenerLine(lastItemLine)) {
                  // A lazy line keeps its leading whitespace verbatim
                  // when indented < 4 (`- one\n two` -> `one\n two`),
                  // but at indent >= 4 the 4-column indented-code
                  // indent is stripped (`    - e` -> `- e`, cm-312).
                  // A lazy line at indent >= 4 is indented CODE in
                  // marked's inner parse, and a code block's text
                  // carries a trailing newline when a line follows it
                  // (fuzz Pola 3A: the next line then joins with
                  // another \n, giving the \n\n that splits the
                  // paragraph). Consecutive code lines form ONE code
                  // block, so only the last of a run gets it, and a
                  // code line that is the item's last line gets none
                  // (R1: no trailing \n, so no \n\n is produced).
                  let lazyText = indentOf(cl) >= 4 ? stripCodeIndent(cl) : cl;
                  if (indentOf(cl) >= 4) {
                    const nx = lines[j + 1];
                    // The next line continues the code run only if it
                    // is itself a LAZY code line (indent < content
                    // indent, >= 4); a regular content line (indent >=
                    // content indent) is a separate item line, not
                    // part of the run (P3A: `      update...` at
                    // indent 6 >= base 5 is regular content).
                    const nextIsCode = j + 1 < end && !isBlankLine(nx) &&
                      indentOf(nx) >= 4 && indentOf(nx) < info.contentIndent &&
                      !interruptsParagraph(lines, j + 1, inList) &&
                      !matchListStart(nx) && !isFenceOpenerLine(nx);
                    const hasFollowing = j + 1 < end && !isBlankLine(nx) &&
                      !matchListStart(nx);
                    if (!nextIsCode && hasFollowing) lazyText += '\n';
                  }
                  itemLines[itemLines.length - 1] = lastItemLine + '\n' + lazyText;
                  j++;
                  continue;
                }
              }
              break;
            }
            // Strip trailing blank lines from the item (but keep the
            // empty firstLine of an empty item; stripping it would
            // wrongly mark the list loose).
            while (itemLines.length > 1 && isBlankLine(itemLines[itemLines.length - 1])) {
              itemLines.pop();
              pendingBlank = true;
            }
            // Trailing spaces at the very end of the item are dropped
            // (marked trimEnds the item text): `1. foo  ` renders
            // `<li>foo</li>`, not `<li>foo  </li>` (fuzz Pola 2).
            {
              const last = itemLines[itemLines.length - 1];
              if (last !== undefined && !isBlankLine(last)) {
                itemLines[itemLines.length - 1] = last.replace(/[ \t]+$/, '');
              }
            }
            // Preserve the trailing-newline info: if the item's last
            // content line is followed by a newline in the parent, append
            // a blank line so nested code blocks see it.
            {
              let lastIdx = j - 1;
              while (lastIdx >= itemStart && isBlankLine(lines[lastIdx])) lastIdx--;
              if (lastIdx >= itemStart && lastIdx < lines.length - 1) itemLines.push('');
            }
            items.push(itemLines);
            continue;
          }
          break;
        }
        // Loose if any item's own parse has a blank line between two
        // of its top-level blocks (blank lines inside a nested block
        // do not loosen the outer list).
        const parsedItems = [];
        for (const itemLines of items) {
          const inner = [];
          if (blockParse(itemLines, 0, itemLines.length, refs, inner, false, true)) loose = true;
          parsedItems.push(inner);
        }
        // Defer rendering for the same reason as the blockquote.
        out.push({ kind: 'list', ordered, startNum, loose, items: parsedItems });
        i = j;
        continue;
      }
    }

    // Link reference definition: [label]: dest "title" (up to 3 lines).
    {
      const def = matchDef(lines, i, end);
      if (def) {
        const key = normalizeLabel(def.label);
        if (!refs.has(key)) refs.set(key, { href: def.href, title: def.title });
        i = def.next;
        continue;
      }
    }

    // HTML block (types 1-7).
    {
      const htmlBlock = matchHtmlBlock(lines, i, end, isTop);
      if (htmlBlock) {
        out.push(htmlBlock.html);
        i = htmlBlock.next;
        continue;
      }
    }

    // Table: header + delimiter + body.
    {
      const table = matchTable(lines, i, end);
      if (table) {
        out.push({ kind: 'table', headerCells: table.headerCells, aligns: table.aligns, body: table.body });
        i = table.next;
        continue;
      }
    }

    // Setext heading: text lines + === or --- underline.
    {
      const setext = matchSetext(lines, i, end, inList);
      if (setext) {
        out.push({ s: setext.text, pre: '<h' + setext.level + '>', post: '</h' + setext.level + '>\n' });
        i = setext.next;
        continue;
      }
    }

    // Paragraph: lines until a blank line or a paragraph-interrupting line.
    {
      const para = [];
      let j = i;
      while (j < end) {
        const l = lines[j];
        if (isBlankLine(l)) break;
        if (j > i && interruptsParagraph(lines, j, inList)) break;
        // Inside a list item, a continuation line indented by 4+
        // columns loses exactly 4 (marked's paragraph text: the
        // list already stripped the content indent, and the inner
        // parse drops the indented-code indent). At indent < 4 the
        // whitespace is kept verbatim. Top-level paragraphs and
        // top-level blockquotes keep their indent (fuzz Pola 1).
        // A continuation line at indent >= 4 is indented CODE in
        // marked's inner parse, and a code block's text carries a
        // trailing newline when a line follows it (fuzz Pola 3A):
        // only the last line of a run of such lines gets the
        // trailing \n, and only when the paragraph continues after
        // it (a code line that is the paragraph's last line gets
        // none, R1).
        if (j > i && inList && indentOf(l) >= 4) {
          let t = stripCodeIndent(l);
          const nx = lines[j + 1];
          const nextIsCode = j + 1 < end && !isBlankLine(nx) &&
            indentOf(nx) >= 4 && !interruptsParagraph(lines, j + 1, inList);
          const continues = j + 1 < end && !isBlankLine(nx) &&
            !interruptsParagraph(lines, j + 1, inList);
          if (!nextIsCode && continues) t += '\n';
          para.push(t);
        } else para.push(l);
        j++;
      }
      out.push({ s: para.join('\n'), pre: '<p>', post: '</p>\n' });
      i = j;
      continue;
    }
  }
  return blankBetween;
}

// Render one blockParse item to HTML. Called only after the whole block
// pass is done, so every link reference definition is known.
function renderItem(item, refs, state) {
  if (typeof item === 'string') return item;
  if (item.kind === 'blockquote') {
    let html = '<blockquote>\n';
    for (const sub of item.inner) html += renderItem(sub, refs, state);
    return html + '</blockquote>\n';
  }
  if (item.kind === 'list') {
    let html = item.ordered ? '<ol' : '<ul';
    if (item.ordered && item.startNum !== 1) html += ' start="' + item.startNum + '"';
    html += '>\n';
    for (const inner of item.items) {
      html += '<li>';
      let first = true;
      for (const sub of inner) {
        // Task list item: a leading [ ] / [x] / [X] in the first
        // paragraph becomes a disabled checkbox.
        if (first && typeof sub === 'object' && sub.pre === '<p>') {
          const tm = /^\[([ xX])\][ \t]+/.exec(sub.s) || /^\[([ xX])\]$/.exec(sub.s);
          if (tm) {
            const checked = tm[1] === 'x' || tm[1] === 'X';
            const rest = sub.s.slice(tm[0].length);
            const box = checked ? '<input checked="" disabled="" type="checkbox">' :
              '<input disabled="" type="checkbox">';
            if (!item.loose) html += box + ' ' + inlineTo(rest, refs, false, state);
            else html += '<p>' + box + ' ' + inlineTo(rest, refs, false, state) + '</p>\n';
            first = false;
            continue;
          }
        }
        first = false;
        if (!item.loose && typeof sub === 'object' && sub.pre === '<p>') {
          html += inlineTo(sub.s, refs, false, state);
        } else {
          html += renderItem(sub, refs, state);
        }
      }
      html += '</li>\n';
    }
    return html + (item.ordered ? '</ol>\n' : '</ul>\n');
  }
  if (item.kind === 'table') {
    let html = '<table>\n<thead>\n<tr>\n';
    for (let c = 0; c < item.headerCells.length; c++) {
      html += '<th' + (item.aligns[c] ? ' align="' + item.aligns[c] + '"' : '') + '>' +
        inlineTo(item.headerCells[c].trim(), refs, false, state) + '</th>\n';
    }
    html += '</tr>\n</thead>\n';
    if (item.body.length > 0) {
      html += '<tbody>';
      for (const row of item.body) {
        const cells = splitTableRow(row);
        html += '<tr>\n';
        for (let c = 0; c < item.headerCells.length; c++) {
          const cell = c < cells.length ? cells[c] : '';
          html += '<td' + (item.aligns[c] ? ' align="' + item.aligns[c] + '"' : '') + '>' +
            inlineTo(cell.trim(), refs, false, state) + '</td>\n';
        }
        html += '</tr>\n';
      }
      html += '</tbody>';
    }
    return html + '</table>\n';
  }
  return item.pre + inlineTo(item.s, refs, false, state) + item.post;
}

// Match a list-item start on a line. Returns null, or an object with the
// list kind, the marker, the content indent, and the first content line.
function matchListStart(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k > 3) return null;
  const rest = line.slice(k);
  // Unordered: *, +, - followed by space/tab (or end of line).
  if (rest[0] === '*' || rest[0] === '+' || rest[0] === '-') {
    if (rest.length === 1) {
      return { ordered: false, bullet: rest[0], delimiter: null, startNum: 0, contentIndent: k + 2, firstLine: '' };
    }
    if (rest[1] === ' ' || rest[1] === '\t') {
      // Count the spaces after the marker (a tab counts as to the next
      // multiple of 4). 1-4 spaces -> content indent is marker + spaces;
      // 5+ spaces -> content indent is marker + 1. An EMPTY item uses
      // marker + 1 (the spaces after the marker do not count).
      let sp = 0;
      let t = 1;
      let col = k + 1;
      while (t < rest.length && (rest[t] === ' ' || rest[t] === '\t')) {
        if (rest[t] === ' ') { sp++; col++; t++; }
        else { const w = 4 - (col % 4); sp += w; col += w; t++; }
      }
      const firstLine = sp >= 1 && sp <= 4 ? rest.slice(t) : ' '.repeat(sp - 1) + rest.slice(t);
      const contentIndent = firstLine === '' ? k + 2 :
        (sp >= 1 && sp <= 4 ? k + 1 + sp : k + 2);
      return { ordered: false, bullet: rest[0], delimiter: null, startNum: 0, contentIndent, firstLine };
    }
    return null;
  }
  // Ordered: 1-9 digits + . or ) followed by space/tab (or end of line).
  const m = /^(\d{1,9})([.)])/.exec(rest);
  if (m) {
    const after = rest.slice(m[0].length);
    if (after === '') {
      return { ordered: true, bullet: null, delimiter: m[2], startNum: parseInt(m[1], 10), contentIndent: k + m[0].length + 1, firstLine: '' };
    }
    if (after[0] === ' ' || after[0] === '\t') {
      let sp = 0;
      let t = 0;
      let col = k + m[0].length;
      while (t < after.length && (after[t] === ' ' || after[t] === '\t')) {
        if (after[t] === ' ') { sp++; col++; t++; }
        else { const w = 4 - (col % 4); sp += w; col += w; t++; }
      }
      const firstLine = sp >= 1 && sp <= 4 ? after.slice(t) : ' '.repeat(sp - 1) + after.slice(t);
      const contentIndent = firstLine === '' ? k + m[0].length + 1 :
        (sp >= 1 && sp <= 4 ? k + m[0].length + sp : k + m[0].length + 1);
      return { ordered: true, bullet: null, delimiter: m[2], startNum: parseInt(m[1], 10), contentIndent, firstLine };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block matchers: def, table, setext, html block
// ---------------------------------------------------------------------------

// Link reference definition: [label]: dest "title" (up to 3 lines).
// Matches marked's def regex (Fe): label has no nested brackets and no
// blank line; dest is bare or <angle>; title is "…" / '…' / (…) after
// spaces or a newline.
const DEF_RE = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;

function matchDef(lines, i, end) {
  // A def's title may span several lines; join up to 10 lines (the
  // regex itself refuses to cross a blank line).
  const text = lines.slice(i, Math.min(i + 10, end)).join('\n');
  const m = DEF_RE.exec(text);
  if (!m) return null;
  const label = m[1];
  if (!label || label.trim() === '' || label.indexOf('\n\n') !== -1) return null;
  let dest = m[2];
  if (dest[0] === '<') dest = dest.slice(1, -1);
  dest = resolveDestEscapes(dest);
  let title = null;
  if (m[3] != null) {
    title = resolveDestEscapes(m[3].slice(1, -1));
  }
  const href = cleanUrl(dest);
  if (href === null) return null;
  const nl = (m[0].match(/\n/g) || []).length;
  const consumed = m[0].endsWith('\n') ? nl : nl + 1;
  return { label, href, title, next: i + consumed };
}

// Split a table row on unescaped |, dropping a leading/trailing empty cell.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let k = 0;
  while (k < line.length) {
    const c = line[k];
    if (c === '\\' && k + 1 < line.length && line[k + 1] === '|') {
      // An escaped pipe is a literal pipe in the cell (the backslash
      // is consumed here, before inline parsing).
      cur += '|';
      k += 2;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      k++;
      continue;
    }
    cur += c;
    k++;
  }
  cells.push(cur);
  // Drop a leading empty cell (line starts with |) and a trailing empty
  // cell (line ends with |).
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

// Does the line at `li` end a table body (a block start: hr, heading,
// blockquote, fences, list, indented code, html)? The table regex's
// lookahead excludes exactly these.
function isTableBodyEnd(lines, li) {
  const line = lines[li];
  // A whitespace-only line containing a tab is an empty table row,
  // not a table end (doc-02: a `\t` line becomes a row of empty
  // cells, and the table continues). A spaces-only line ends the
  // table (the body loop breaks on /^ *$/ before reaching here).
  if (isBlankLine(line) && line.indexOf('\t') !== -1) return false;
  if (indentOf(line) >= 4) return true;
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k > 3) return false;
  const rest = line.slice(k);
  if (/^(?:-[ \t]*){3,}$/.test(rest) || /^(?:_[ \t]*){3,}$/.test(rest) ||
      /^(?:\*[ \t]*){3,}$/.test(rest)) return true;
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return true;
  if (rest[0] === '>') return true;
  if (/^(?:`{3,}|~{3,})/.test(rest)) return true;
  // The table-body lookahead's list pattern requires 1[.)] for ordered.
  if (/^(?:[*+-]|1[.)])(?:[ \t]+[^ \t\n]|$)/.test(rest)) return true;
  if (isHtmlBlockStart(line)) return true;
  return false;
}

function matchTable(lines, i, end) {
  if (i + 1 >= end) return null;
  const header = lines[i];
  const delim = lines[i + 1];
  if (isBlankLine(header)) return null;
  let h = 0;
  while (h < header.length && header[h] === ' ') h++;
  if (h > 3) return null;
  let d = 0;
  while (d < delim.length && delim[d] === ' ') d++;
  if (d > 3) return null;
  const drest = delim.slice(d);
  if (!/^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(drest)) return null;
  if (drest.indexOf('|') === -1) return null;
  const headerCells = splitTableRow(header);
  const delimCells = splitTableRow(delim);
  if (headerCells.length !== delimCells.length) return null;
  const aligns = delimCells.map(c => {
    const t = c.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  const body = [];
  let j = i + 2;
  while (j < end) {
    const l = lines[j];
    // A line of only spaces (or empty) ends the table, but a
    // whitespace-only line containing a tab is an empty row
    // (doc-02: `\t` -> row of empty cells; doc-05: `   ` ends it).
    if (/^ *$/.test(l)) break;
    if (isTableBodyEnd(lines, j)) break;
    body.push(l);
    j++;
  }
  return { headerCells, aligns, body, next: j };
}

// Setext heading: text lines + === or --- underline.
function matchSetext(lines, i, end, inList) {
  const textLines = [];
  let j = i;
  while (j < end) {
    const l = lines[j];
    if (isBlankLine(l)) return null;
    // The underline: up to 3 spaces, 1+ = or -, trailing spaces only.
    // A setext heading needs at least one text line.
    let k = 0;
    while (k < l.length && l[k] === ' ') k++;
    if (k <= 3 && textLines.length > 0) {
      const rest = l.slice(k);
      // A line of only = or - (with trailing spaces).
      if (/^=+[ \t]*$/.test(rest) || /^-+[ \t]*$/.test(rest)) {
        const level = rest[0] === '=' ? 1 : 2;
        // Strip the block indent (up to 3 spaces) from the first line
        // and trailing whitespace from the last line.
        const first = textLines[0].replace(/^ {0,3}/, '');
        const last = textLines[textLines.length - 1].replace(/[ \t]+$/, '');
        const text = textLines.length === 1 ? first.replace(/[ \t]+$/, '') :
          [first].concat(textLines.slice(1, -1), [last]).join('\n');
        return { text, level, next: j + 1 };
      }
    }
    // Otherwise it must be a plain text line: no block start, no 4+ indent.
    if (indentOf(l) >= 4) return null;
    if (j > i && interruptsParagraph(lines, j, inList)) return null;
    textLines.push(l);
    j++;
  }
  return null;
}

// Finish an html block. The raw text runs from line i to the start of the
// next non-blank line after endLine (or EOF); ge() then strips trailing
// blank lines, keeping at most one trailing newline.
function finishHtmlBlock(lines, i, endLine, end, isTop, toBlank) {
  // The html block is lines[i..endLine]. Trailing \n rule depends
  // on the type. Types 1-5 end at a closing construct: a trailing
  // \n is present exactly when the next line exists and is not
  // truly empty -- a whitespace-only next line (e.g. doc-15's `\t`
  // after `-->`) still counts (`-->\n\t\nbar` -> `-->\n<p>bar</p>`),
  // while a truly empty next line cancels it. Types 6-7 run to a
  // blank line: a trailing \n is present only when the next line
  // is non-blank (`<div>..</div>\n\t\nbar` -> `</div><p>bar</p>`,
  // doc-03). A '' at the very end of the TOP-LEVEL range is the
  // split artifact of a trailing newline (not a blank line), so it
  // still gets a \n. (In a nested range the trailing '' is a
  // synthetic separator, so it does not add a \n.)
  let text = lines.slice(i, endLine + 1).join('\n');
  const ni = endLine + 1;
  if (ni < end) {
    const counts = toBlank ? !isBlankLine(lines[ni]) : lines[ni] !== '';
    if (counts) text += '\n';
    else if (isTop && ni === end - 1 && lines[ni] === '') text += '\n';
  }
  return { html: text, next: endLine + 1 };
}

function matchHtmlBlock(lines, i, end, isTop) {
  const line = lines[i];
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k > 3 || line[k] !== '<') return null;
  const rest = line.slice(k);
  // Type 1: script / pre / style / textarea. Runs to the closing tag or EOF.
  {
    const m = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
    if (m) {
      const tag = m[1].toLowerCase();
      const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
      let endLine = -1;
      for (let j = i; j < end; j++) {
        if (closeRe.test(lines[j])) { endLine = j; break; }
      }
      if (endLine === -1) endLine = end - 1;
      return finishHtmlBlock(lines, i, endLine, end, isTop);
    }
  }
  // Type 2: comment. Runs to --> or EOF.
  if (rest.startsWith('<!--')) {
    let endLine = -1;
    for (let j = i; j < end; j++) {
      if (lines[j].indexOf('-->') !== -1) { endLine = j; break; }
    }
    if (endLine === -1) endLine = end - 1;
    return finishHtmlBlock(lines, i, endLine, end, isTop);
  }
  // Type 3: processing instruction. Runs to ?> or EOF.
  if (rest.startsWith('<?')) {
    let endLine = -1;
    for (let j = i; j < end; j++) {
      if (lines[j].indexOf('?>') !== -1) { endLine = j; break; }
    }
    if (endLine === -1) endLine = end - 1;
    return finishHtmlBlock(lines, i, endLine, end, isTop);
  }
  // Type 4: declaration <!Letter. Runs to the first > or EOF.
  if (/^<![A-Za-z]/.test(rest)) {
    let endLine = -1;
    for (let j = i; j < end; j++) {
      if (lines[j].indexOf('>') !== -1) { endLine = j; break; }
    }
    if (endLine === -1) endLine = end - 1;
    return finishHtmlBlock(lines, i, endLine, end, isTop);
  }
  // Type 5: CDATA. Runs to ]]> or EOF.
  if (rest.startsWith('<![CDATA[')) {
    let endLine = -1;
    for (let j = i; j < end; j++) {
      if (lines[j].indexOf(']]>') !== -1) { endLine = j; break; }
    }
    if (endLine === -1) endLine = end - 1;
    return finishHtmlBlock(lines, i, endLine, end, isTop);
  }
  // Type 6: a block tag (open or close). The char after the tag name must
  // be a space, tab, newline, >, />, or end. Runs to a blank line or EOF.
  {
    const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
      const after = rest.slice(m[0].length);
      if (after === '' || after[0] === ' ' || after[0] === '\t' ||
          after[0] === '>' || after.startsWith('/>')) {
        let endLine = i;
        while (endLine + 1 < end && !isBlankLine(lines[endLine + 1])) endLine++;
        return finishHtmlBlock(lines, i, endLine, end, isTop, true);
      }
    }
  }
  // Type 7: any other tag, a complete open or close tag that ends the line.
  // Runs to a blank line or EOF.
  {
    const te = matchTag(rest, 0, rest.length);
    if (te > 0) {
      let t = te;
      while (t < rest.length && (rest[t] === ' ' || rest[t] === '\t')) t++;
      if (t === rest.length) {
        let endLine = i;
        while (endLine + 1 < end && !isBlankLine(lines[endLine + 1])) endLine++;
        return finishHtmlBlock(lines, i, endLine, end, isTop, true);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(src) {
  const text = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  const refs = new Map();
  const out = [];
  blockParse(lines, 0, lines.length, refs, out, true);
  // Document-level inline state (marked's lexer state, created once
  // per document and never reset between blocks): inLink/inRawBlock
  // persist across the whole document (an unclosed `<a />` suppresses
  // all later bare URLs). linkEmitted is managed by De save/restore.
  const state = { inLink: false, inRawBlock: false, linkEmitted: false };
  let html = '';
  for (const item of out) html += renderItem(item, refs, state);
  return html;
}

export default parse;
