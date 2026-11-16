// marked-fast: a single-pass Markdown renderer, byte-identical to
// marked 18.1.3 with its default options (GFM on, breaks off).
// Written from scratch: blocks are lexed into a flat node list (link
// reference definitions are collected in document order, first label wins,
// exactly as marked does), then each block's inline content is rendered
// straight to HTML while scanning - no inline token tree, no second walk.
// The regular expressions below are the grammar of the language (the same
// shapes marked uses to define each construct); all control flow, data
// structures and rendering are this file's own.

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---- small shared patterns -------------------------------------------------
const PUNCT = /[\p{P}\p{S}]/u;                 // any punctuation / symbol
const PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u; // punctuation except ~
const SPACE_PUNCT = /[\s\p{P}\p{S}]/u;         // space or punctuation
const SPACE_PUNCT_NOT_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_SPACE_PUNCT = /[^\s\p{P}\p{S}]/u;    // word character-ish
const NOT_SPACE_PUNCT_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const ALPHA_NUM = /[\p{L}\p{N}]/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const reBlankLine = /^[ \t]*$/;
const reDoubleBlankLine = /\n[ \t]*\n[ \t]*$/;
const reBlockquoteStart = /^ {0,3}>/;
const reBlockquoteSetext = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const reBlockquoteMarker = /^ {0,3}>[ \t]?/gm;
const reBlockquoteMarkerWs = /^( {0,3}>)([ \t]+)/gm;
const reListNesting = /^ {1,4}(?=( {4})*[^ ])/g;
const reListIsTask = /^\[[ xX]\][ \t]+\S/;
const reListReplaceTask = /^\[[ xX]\][ \t]+/;
const reListTaskCheckbox = /\[[ xX]\]/;
const reAnyLine = /\n.*\n/;
const reHrefBrackets = /^<(.*)>$/;
const reTableDelim = /[:|]/;
const reTableAlignChars = /^\||\| *$/g;
const reTableRowBlank = /\n[ \t]*$/;
const reAlignRight = /^ *-+: *$/;
const reAlignCenter = /^ *:-+: *$/;
const reAlignLeft = /^ *:-+ *$/;
const reStartATag = /^<a /i;
const reEndATag = /^<\/a>/i;
const reStartPreTag = /^<(pre|code|kbd|script)(\s|>)/i;
const reEndPreTag = /^<\/(pre|code|kbd|script)(\s|>)/i;
const reStartAngle = /^</;
const reEndAngle = />$/;
const reNotSpaceStart = /^\S*/;
const reEndingNewline = /\n$/;
const reEndingHash = /#$/;
const reEndingSpaceTab = /[ \t]$/;
const reEndingSpace = / $/;
const reStartingSpace = /^ /;
const reCodeRemoveIndent = /^(?: {0,3}\t| {1,4})/gm;
const reOutputLinkReplace = /\\([\[\]])/g;
const reIndentCodeComp = /^(\s+)(?:```)/;
const reBeginningSpace = /^\s+/;
const reLeadingSpaceTab = /^[ \t]+/;
const reMultiSpace = /\s+/g;
const reNonSpace = /[^ ]/;
const reNewlineGlobal = /\n/g;
const reTabGlobal = /\t/g;
const reSpaceLine = /^ +$/gm;
const rePercentDecode = /%25/g;
const reFindPipe = /\|/g;
const reSplitPipe = / \|/;
const reSlashPipe = /\\\|/g;
const reCarriageReturn = /\r\n|\r/g;
const reEscapeTest = /[&<>"']/;
const reEscapeReplace = /[&<>"']/g;
const reEscapeTestNoEnc = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const reEscapeReplaceNoEnc = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const reNumericRef = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const reNumericRefOrAmp = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// ---- block grammar (GFM) ---------------------------------------------------
// The paragraph / setext / table patterns are built by string substitution,
// exactly the way marked composes them: a `^` anchor at the start of a
// substituted fragment is dropped (marked's caret rule), so the fragments
// can match mid-string inside a lookahead. Order and first-occurrence
// semantics of the substitutions are preserved.
const caretStripRe = /(^|[^\[])\^/g;
function subPat(src, name, repl, global = false) {
  const r = typeof repl === 'string' ? repl : repl.source;
  const cleaned = r.replace(caretStripRe, '$1');
  if (global) return src.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), cleaned);
  return src.replace(name, cleaned);
}
const HR_RE_SRC = '^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HR_ALT = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_ALT = ' {0,3}#{1,6}(?:\\s|$)';
const BLOCKQUOTE_ALT = ' {0,3}>';
const FENCES_PARA_ALT = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const FENCES_LH_ALT = ' {0,3}(?:`{3,}|~{3,})';
const HTML_PARA_ALT = ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`;
const HTML_LH_ALT = ' {0,3}<[^\\n>]+>\\n';
const TABLE_LH_ALT = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';
const BULL_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const BLOCKCODE_ALT = '(?: {4}| {0,3}\\t)';
const LIST_GFM_ALT = ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
const LIST_XE_ALT = ' {0,3}(?:[*+-]|1[.)])[ \\t]';
const CODE_XE_ALT = '(?: {4}| {0,3}\\t)[^\\n]';

const HR_RE = new RegExp(`^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
const HEADING_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const NEWLINE_RE = /^(?:[ \t]*(?:\n|$))+/;
const INDENTED_CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES_RE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const LIST_RE = new RegExp(`^(${BULL_SRC})([ \\t][^\\n]*?)?(?:\\n|$)`);
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_BLOCK_RE = new RegExp(
  `^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|` +
  `${HTML_COMMENT.source}[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|` +
  `</?(?:${BLOCK_TAGS})(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|` +
  `<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *'[^'\\n]*'| *= *[^\\s"'=<>` + '`' + `]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|` +
  `</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))`, 'i');
// table regex (xe): header line, delimiter row, body rows
let XE_SRC = '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
XE_SRC = subPat(XE_SRC, 'hr', HR_RE_SRC);
XE_SRC = subPat(XE_SRC, 'heading', HEADING_ALT);
XE_SRC = subPat(XE_SRC, 'blockquote', BLOCKQUOTE_ALT);
XE_SRC = subPat(XE_SRC, 'code', CODE_XE_ALT);
XE_SRC = subPat(XE_SRC, 'fences', FENCES_PARA_ALT);
XE_SRC = subPat(XE_SRC, 'list', LIST_XE_ALT);
XE_SRC = subPat(XE_SRC, 'html', HTML_PARA_ALT);
XE_SRC = subPat(XE_SRC, 'tag', BLOCK_TAGS);
const TABLE_RE = new RegExp(XE_SRC);
// setext-heading regex (Ge)
let OE_SRC = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
OE_SRC = subPat(OE_SRC, 'bull', BULL_SRC, true);
OE_SRC = subPat(OE_SRC, 'blockCode', BLOCKCODE_ALT, true);
OE_SRC = subPat(OE_SRC, 'fences', FENCES_LH_ALT, true);
OE_SRC = subPat(OE_SRC, 'blockquote', BLOCKQUOTE_ALT, true);
OE_SRC = subPat(OE_SRC, 'heading', HEADING_ALT, true);
OE_SRC = subPat(OE_SRC, 'hr', HR_ALT, true);
OE_SRC = subPat(OE_SRC, 'html', HTML_LH_ALT, true);
OE_SRC = OE_SRC.replace(/\|table/g, TABLE_LH_ALT);
const LHEADING_RE = new RegExp(OE_SRC);
// paragraph regex (Ve.paragraph)
let AE_SRC = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
AE_SRC = subPat(AE_SRC, 'hr', HR_RE_SRC);
AE_SRC = subPat(AE_SRC, 'heading', HEADING_ALT);
AE_SRC = subPat(AE_SRC, '|lheading', '');
AE_SRC = subPat(AE_SRC, 'table', TABLE_RE);
AE_SRC = subPat(AE_SRC, 'blockquote', BLOCKQUOTE_ALT);
AE_SRC = subPat(AE_SRC, 'fences', FENCES_PARA_ALT);
AE_SRC = subPat(AE_SRC, 'list', LIST_GFM_ALT);
AE_SRC = subPat(AE_SRC, 'html', HTML_PARA_ALT);
AE_SRC = subPat(AE_SRC, 'tag', BLOCK_TAGS);
const PARA_GFM_RE = new RegExp(AE_SRC);
const TEXT_RE = /^[^\n]+/;
const BLOCKQUOTE_RE = new RegExp(`^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(${subPat(PARA_GFM_RE.source, '^', '')})|[^\\n]*)(?:\\n|$))+`);

// ---- inline grammar (GFM) --------------------------------------------------
const INLINE_ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const INLINE_TAG_RE = new RegExp(
  `^${HTML_COMMENT.source.replace('(?:-->|$)', '-->')}|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s"'=<>` + '`' + `]+)?)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>`);
const BRACKETS_RE = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL_RE = new RegExp(`(?:\\[(?:${BRACKETS_RE.source}|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|\`+(?!\`)[^\`]*?\`+(?!\`)|\\\`\\\`+(?=\\])|[^\\[\\]\\\\\`])*?`);
const LINK_HREF_RE = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const LINK_TITLE_RE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
const INLINE_LINK_RE = new RegExp(`^!?\\[(${LINK_LABEL_RE.source})\\]\\([ \\t\\n]*(${LINK_HREF_RE.source})(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(${LINK_TITLE_RE.source}))?[ \\t\\n]*\\)`);
const LABEL_RE = /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)/;
const DEF_TITLE_RE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)/;
const DEF_RE = new RegExp(`^ {0,3}\\[(${LABEL_RE.source})\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(${DEF_TITLE_RE.source}))? *(?:\\n+|$)`);
const REFLINK_RE = new RegExp(`^!?\\[(${LINK_LABEL_RE.source})\\]\\[(${LABEL_RE.source})\\]`);
const NOLINK_RE = new RegExp(`^!?\\[(${LABEL_RE.source})\\](?:\\[\\])?`);
const REFLINK_LABEL_LONG = new RegExp(`(?:[^\\[\\]\\\`]*(?:\\[(?:${BRACKETS_RE.source}|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|\`+(?!\`)[^\`]*?\`+(?!\`)|\`\`+(?=\\]))){0,999}?[^\\[\\]\\\`]*?`);
const REFLINK_LABEL_SHORT = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_SEARCH_RE = new RegExp(`(?:!?\\[(${REFLINK_LABEL_LONG.source})\\]\\[(${REFLINK_LABEL_SHORT.source})\\]|!?\\[(${REFLINK_LABEL_SHORT.source})\\](?:\\[\\])?(?!\\())`, 'g');
const AUTOLINK_RE = new RegExp(`^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_\`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>`);
const EMAIL_NO_GROUP_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_GROUP_RE = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const URL_RE = new RegExp(`^(?:(?:mailto:${EMAIL_NO_GROUP_RE.source}|xmpp:${EMAIL_NO_GROUP_RE.source}(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^${EMAIL_GROUP_RE.source})`);
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const URL_START_RE = /^(?:mailto:|xmpp:|https?:\/\/|ftp:\/\/|www\.|[A-Za-z0-9._+\-]*@)/i;
const DEL_RE = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const EM_LDELIM_RE = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const EM_RDELIM_AST_RE = new RegExp(
  `^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)${PUNCT_NOT_TILDE.source}(\\*+)(?=[\\s]|$)|${NOT_SPACE_PUNCT_TILDE.source}(\\*+)(?!\\*)(?=${SPACE_PUNCT_NOT_TILDE.source}|$)|(?!\\*)${SPACE_PUNCT_NOT_TILDE.source}(\\*+)(?=${NOT_SPACE_PUNCT_TILDE.source})|[\\s](\\*+)(?!\\*)(?=${PUNCT_NOT_TILDE.source})|(?!\\*)${PUNCT_NOT_TILDE.source}(\\*+)(?!\\*)(?=${PUNCT_NOT_TILDE.source})|${NOT_SPACE_PUNCT_TILDE.source}(\\*+)(?=${NOT_SPACE_PUNCT_TILDE.source})`, 'gu');
const EM_RDELIM_UND_RE = new RegExp(
  `^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)${PUNCT_NOT_TILDE.source}(_+)(?=[\\s]|$)|${NOT_SPACE_PUNCT_TILDE.source}(_+)(?!_)(?=${SPACE_PUNCT_NOT_TILDE.source}|$)|(?!_)${SPACE_PUNCT_NOT_TILDE.source}(_+)(?=${NOT_SPACE_PUNCT_TILDE.source})|[\\s](_+)(?!_)(?=${PUNCT_NOT_TILDE.source})|(?!_)${PUNCT_NOT_TILDE.source}(_+)(?!_)(?=${PUNCT_NOT_TILDE.source})`, 'gu');
const DEL_LDELIM_RE = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const DEL_RDELIM_RE = new RegExp(
  `^[^~]+(?=[^~])|(?!~)${PUNCT.source}(~~?)(?=[\\s]|$)|${NOT_SPACE_PUNCT.source}(~~?)(?!~)(?=${SPACE_PUNCT.source}|$)|(?!~)${SPACE_PUNCT.source}(~~?)(?=${NOT_SPACE_PUNCT.source})|[\\s](~~?)(?!~)(?=${PUNCT.source})|(?!~)${PUNCT.source}(~~?)(?!~)(?=${PUNCT.source})|${NOT_SPACE_PUNCT.source}(~~?)(?=${NOT_SPACE_PUNCT.source})`, 'gu');
const INLINE_TEXT_RE = new RegExp(
  `^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(\`+|~+|[^\`~])(?:(?=[\`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_\`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[\`*~_]|\\b_|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_\`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_\`{\\|}~-]+@))))`);
const PUNCT_START_RE = /^((?![*_])[\s\p{P}\p{S}])/u;
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// per-indent helper regexes (cached by indent width, like marked does)
const listItemRegexCache = new Map();
function listItemRegex(bullet) {
  let r = listItemRegexCache.get(bullet);
  if (!r) { r = new RegExp(`^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`); listItemRegexCache.set(bullet, r); }
  return r;
}
function cachedRegex(cache, n, make) {
  const a = Math.max(0, Math.min(3, n - 1));
  let r = cache.get(a);
  if (!r) { r = make(a); cache.set(a, r); }
  return r;
}
const nextBulletCache = new Map();
const hrCache = new Map();
const fencesBeginCache = new Map();
const headingBeginCache = new Map();
const htmlBeginCache = new Map();
const blockquoteBeginCache = new Map();
const nextBulletRegex = n => cachedRegex(nextBulletCache, n, a => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegex = n => cachedRegex(hrCache, n, a => new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = n => cachedRegex(fencesBeginCache, n, a => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`));
const headingBeginRegex = n => cachedRegex(headingBeginCache, n, a => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = n => cachedRegex(htmlBeginCache, n, a => new RegExp(`^ {0,${a}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = n => cachedRegex(blockquoteBeginCache, n, a => new RegExp(`^ {0,${a}}>`));

// First non-space character of a line, but only when it sits within the
// allowed leading-space budget (the block-begin regexes only allow that many
// spaces before their marker). Returns '' when the line is blank or the
// first non-space char is too far in — then no begin-pattern can match.
const BEGIN_MARKERS = '`~#<>*+-_0123456789';
const LAZY_MARKERS = '`~#<>*-_';
function firstMarkerChar(s, maxSpaces) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < maxSpaces) i++;
  if (i >= s.length || s[i] === ' ') return '';
  return s[i];
}

// ---- tiny helpers ------------------------------------------------------------
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s, encodeAll) {
  if (encodeAll) {
    if (reEscapeTest.test(s)) return s.replace(reEscapeReplace, c => ESCAPE_MAP[c]);
  } else if (reEscapeTestNoEnc.test(s)) {
    return s.replace(reEscapeReplaceNoEnc, c => ESCAPE_MAP[c]);
  }
  return s;
}
// Decode numeric character references; escape bare & (marked's unescape step).
function decodeEntities(s) {
  if (!reNumericRef.test(s)) return s;
  return s.replace(reNumericRefOrAmp, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}
function cleanUrl(href) {
  try { return encodeURI(href).replace(rePercentDecode, '%'); } catch { return null; }
}
// Strip trailing chars: without `not`, strip trailing `ch`; with `not`, strip
// trailing chars that are NOT `ch`. Returns the stripped string.
function stripTail(s, ch, not) {
  let n = s.length, k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !not) k++;
    else if (c !== ch && not) k++;
    else break;
  }
  return s.slice(0, n - k);
}
// Drop trailing blank lines, keeping at most one trailing blank line.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && reBlankLine.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}
function normalizeLabel(s) {
  return s.trim().replace(reMultiSpace, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Find the index of the unmatched close char in `pair` (e.g. "()"),
// skipping backslash escapes. -2 = unclosed open, -1 = balanced / none.
function findUnmatchedClose(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}
// Expand tabs to spaces, tab stops every 4 columns starting at `col`.
function expandTabs(s, col = 0) {
  let out = '', pos = col;
  for (const ch of s) {
    if (ch === '\t') { const w = 4 - (pos % 4); out += ' '.repeat(w); pos += w; }
    else { out += ch; pos++; }
  }
  return out;
}
// Split a table row on unescaped pipes (marked's splitCells).
function splitCells(row, colCount) {
  const fixed = row.replace(reFindPipe, (m, off, str) => {
    let escaped = false, p = off;
    for (; --p >= 0 && str[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = fixed.split(reSplitPipe);
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), colCount) {
    if (cells.length > colCount) cells.splice(colCount);
    else for (; cells.length < colCount;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(reSlashPipe, '|');
  return cells;
}
// Fenced-code indent compensation: if the opening fence is indented, dedent
// the content lines by that much (backtick fences only).
function dedentFence(raw, content) {
  const m = raw.match(reIndentCodeComp);
  if (m === null) return content;
  const indent = m[1];
  return content.split('\n').map(line => {
    const lead = line.match(reBeginningSpace);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, indent.length));
  }).join('\n');
}

// ---- block lexing ------------------------------------------------------------
// Lexes `src` into a flat list of block nodes. `top` mirrors marked's
// state.top (paragraphs only lex at top level / inside blockquotes, never
// directly inside list items). `mergePara` lets the first paragraph of a
// blockquote chunk merge into the previous chunk's paragraph. Link reference
// definitions are collected into ctx.links in document order, first label
// wins; a definition that directly follows a paragraph/text line is folded
// into that line instead (marked's rule).
function tokSpace(src) {
  const m = NEWLINE_RE.exec(src);
  return m && m[0].length > 0 ? { t: 'space', raw: m[0] } : null;
}
function tokCode(src) {
  const m = INDENTED_CODE_RE.exec(src);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return { t: 'code', raw, text: raw.replace(reCodeRemoveIndent, '') };
}
function tokFences(src) {
  const m = FENCES_RE.exec(src);
  if (!m) return null;
  return {
    t: 'code', raw: m[0],
    lang: m[2] ? m[2].trim().replace(ANY_PUNCT_RE, '$1') : m[2],
    text: dedentFence(m[0], m[3] || ''),
  };
}
function tokHeading(src) {
  const m = HEADING_RE.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (reEndingHash.test(text)) {
    const s = stripTail(text, '#', false);
    if (!s || reEndingSpaceTab.test(s)) text = s.trim();
  }
  return { t: 'heading', raw: stripTail(m[0], '\n', false), depth: m[1].length, text };
}
function tokHr(src) {
  const m = HR_RE.exec(src);
  return m ? { t: 'hr', raw: stripTail(m[0], '\n', false) } : null;
}
function tokHtml(src) {
  const m = HTML_BLOCK_RE.exec(src);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return { t: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' };
}
function tokDef(src) {
  const m = DEF_RE.exec(src);
  if (!m) return null;
  if (!reStartAngle.test(m[2]) && findUnmatchedClose(m[2], '()') !== -1) return null;
  const href = m[2] ? m[2].replace(reHrefBrackets, '$1').replace(ANY_PUNCT_RE, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT_RE, '$1') : m[3];
  return { t: 'def', raw: stripTail(m[0], '\n', false), tag: normalizeLabel(m[1]), href, title };
}
function tokTable(src) {
  // A table's delimiter row is always the second line, starting with an
  // optional pipe/colon and then dashes; without that the regex cannot match.
  if (!/\n {0,3}(?:\| *)?:?-+/.test(src)) return null;
  const m = TABLE_RE.exec(src);
  if (!m || !reTableDelim.test(m[2])) return null;
  const headerCells = splitCells(m[1]);
  const aligns = m[2].replace(reTableAlignChars, '').split('|');
  const bodyText = m[3] && m[3].trim() ? m[3].replace(reTableRowBlank, '').split('\n') : [];
  if (headerCells.length !== aligns.length) return null;
  const table = { t: 'table', raw: stripTail(m[0], '\n', false), header: [], align: [], rows: [] };
  for (const a of aligns) {
    table.align.push(reAlignRight.test(a) ? 'right' : reAlignCenter.test(a) ? 'center' : reAlignLeft.test(a) ? 'left' : null);
  }
  for (let i = 0; i < headerCells.length; i++) table.header.push({ text: headerCells[i], align: table.align[i] });
  for (const row of bodyText) {
    table.rows.push(splitCells(row, table.header.length).map((cell, p) => ({ text: cell, align: table.align[p] })));
  }
  return table;
}
function tokLheading(src) {
  // A setext underline is always a line starting (after <=3 spaces) with
  // = or -; without such a line the regex cannot match.
  if (!/\n {0,3}[=-]/.test(src)) return null;
  const m = LHEADING_RE.exec(src);
  if (!m) return null;
  return { t: 'heading', raw: stripTail(m[0], '\n', false), depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() };
}
function tokParagraph(src) {
  const m = PARA_GFM_RE.exec(src);
  if (!m) return null;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { t: 'paragraph', raw: m[0], text };
}
function tokText(src) {
  const m = TEXT_RE.exec(src);
  return m ? { t: 'text', raw: m[0], text: m[0] } : null;
}
function tokBlockquote(src, ctx) {
  const m = BLOCKQUOTE_RE.exec(src);
  if (!m) return null;
  const lines = stripTail(m[0], '\n', false).split('\n');
  let raw = '', text = '';
  const nodes = [];
  let rest = lines;
  while (rest.length > 0) {
    let inQuote = false;
    const chunk = [];
    let p = 0;
    for (; p < rest.length; p++) {
      if (reBlockquoteStart.test(rest[p])) { chunk.push(rest[p]); inQuote = true; }
      else if (!inQuote) chunk.push(rest[p]);
      else break;
    }
    rest = rest.slice(p);
    const joined = chunk.join('\n');
    const stripped = joined
      .replace(reBlockquoteMarkerWs, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(reBlockquoteSetext, '\n    $1')
      .replace(reBlockquoteMarker, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + stripped : stripped;
    lexBlocks(stripped, true, nodes, ctx, true);
    if (rest.length === 0) break;
    const last = nodes.at(-1);
    if (!last || last.t === 'code' || last.t === 'heading' || last.t === 'hr' || last.t === 'html' || last.t === 'table') break;
    if (last.t === 'blockquote') {
      const g = last;
      const b = rest.join('\n');
      const m2 = g.raw + '\n' + b.replace(reBlockquoteMarker, '');
      const f = tokBlockquote(m2, ctx);
      nodes[nodes.length - 1] = f;
      const y = m2.substring(f.raw.length).replace(/^\n/, '');
      const rCount = y ? y.split('\n').length : 0;
      const taken = rCount ? rest.slice(0, -rCount) : rest;
      if (taken.length > 0) raw = `${raw}\n${taken.join('\n')}`;
      text = text.substring(0, text.length - g.text.length) + f.text;
      rest = rest.slice(taken.length);
      if (rest.length > 0 && reBlockquoteStart.test(rest[0])) continue;
      break;
    } else if (last.t === 'list') {
      const g = last;
      const b = g.raw + '\n' + rest.join('\n');
      const m2 = tokList(b, ctx);
      nodes[nodes.length - 1] = m2;
      const f = m2.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m2.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = rest.slice(0, f).join('\n');
        raw = `${raw}\n${y}`;
        text = `${text}\n${y}`;
      }
      rest = rest.slice(f);
      continue;
    }
  }
  return { t: 'blockquote', raw, text, nodes };
}
function tokList(src, ctx) {
  const first = LIST_RE.exec(src);
  if (!first) return null;
  const full = src;
  let rest = src;
  const consumed = () => full.length - rest.length;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const list = { t: 'list', raw: '', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
  const bulletPat = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRegex(bulletPat);
  let prevBlank = false;
  while (rest) {
    let emptyItem = false;
    let itemText = '';
    const m = itemRe.exec(rest);
    if (!m || HR_RE.test(rest)) break;
    const itemStart = consumed();
    rest = rest.slice(m[0].length);
    const firstLine = m[2].split('\n', 1)[0];
    const markerLen = m[1].length;
    const content = firstLine.replace(reLeadingSpaceTab, v => expandTabs(v, markerLen));
    const nextLine = rest.split('\n', 1)[0];
    const isEmpty = !content.trim();
    let indent;
    if (isEmpty) indent = markerLen + 1;
    else {
      indent = content.search(reNonSpace);
      indent = indent > 4 ? 1 : indent;
      itemText = content.slice(indent);
      indent += markerLen;
    }
    if (isEmpty && reBlankLine.test(nextLine)) { rest = rest.slice(nextLine.length + 1); emptyItem = true; }
    if (!emptyItem) {
      const nextBullet = nextBulletRegex(indent);
      const hrRe = hrRegex(indent);
      const fenceRe = fencesBeginRegex(indent);
      const headRe = headingBeginRegex(indent);
      const htmlRe = htmlBeginRegex(indent);
      const bqRe = blockquoteBeginRegex(indent);
      const maxLead = Math.max(0, Math.min(3, indent - 1));
      let cur = content;
      let empty = isEmpty;
      let cc = '';
      while (rest) {
        const nl = rest.indexOf('\n');
        const line = nl === -1 ? rest : rest.slice(0, nl);
        const f = line;
        const expanded = f.includes('\t') ? f.replace(reLeadingSpaceTab, v => expandTabs(v, 0)) : f;
        const mc = firstMarkerChar(f, maxLead);
        if (mc && BEGIN_MARKERS.includes(mc) && (fenceRe.test(f) || headRe.test(f) || htmlRe.test(f) || bqRe.test(f) || nextBullet.test(f) || hrRe.test(f))) break;
        const blank = !f.trim();
        if (expanded.search(reNonSpace) >= indent || blank) itemText += '\n' + expanded.slice(indent);
        else if (empty || (cur.includes('\t') ? cur.replace(reTabGlobal, '    ') : cur).search(reNonSpace) >= 4 || ((cc = firstMarkerChar(cur, maxLead)) && LAZY_MARKERS.includes(cc) && (fenceRe.test(cur) || headRe.test(cur) || htmlRe.test(cur) || hrRe.test(cur)))) break;
        else {
          const setextLine = /^ {0,3}(?:=+|-+) *$/.test(f) && LHEADING_RE.test(`${cur}\n${f}`)
            ? `    ${expanded.replace(/^ {0,3}/, '')}` : f;
          itemText += '\n' + setextLine;
        }
        empty = blank;
        rest = nl === -1 ? '' : rest.slice(nl + 1);
        cur = expanded.slice(indent);
      }
    }
    const itemRaw = full.slice(itemStart, consumed());
    if (!list.loose) {
      if (prevBlank) list.loose = true;
      else if (reDoubleBlankLine.test(itemRaw)) prevBlank = true;
    }
    list.items.push({ t: 'list_item', raw: itemRaw, task: reListIsTask.test(itemText), loose: false, text: itemText, nodes: [] });
  }
  const last = list.items.at(-1);
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = full.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    item.nodes = [];
    lexBlocks(item.text, false, item.nodes, ctx, false);
    if (!list.loose) {
      const spaces = item.nodes.filter(n => n.t === 'space');
      if (spaces.length > 0 && spaces.some(n => reAnyLine.test(n.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const firstNode = item.nodes[0];
    if (item.task && firstNode && (firstNode.t === 'text' || firstNode.t === 'paragraph')) {
      item.text = item.text.replace(reListReplaceTask, '');
      firstNode.raw = firstNode.raw.replace(reListReplaceTask, '');
      firstNode.text = firstNode.text.replace(reListReplaceTask, '');
      const cb = reListTaskCheckbox.exec(item.raw);
      if (cb) {
        const box = { t: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = box.checked;
        if (list.loose) {
          firstNode.checkbox = box;
        } else {
          item.checkboxFirst = box;
        }
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const n of item.nodes) if (n.t === 'text') n.t = 'paragraph';
    }
  }
  return list;
}
function lexBlocks(src, top, nodes, ctx, mergePara) {
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let tok;
    if ((tok = tokSpace(src))) {
      src = src.slice(tok.raw.length);
      const prev = nodes.at(-1);
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else nodes.push(tok);
      continue;
    }
    if ((tok = tokCode(src))) {
      src = src.slice(tok.raw.length);
      const prev = nodes.at(-1);
      if (prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
      } else nodes.push(tok);
      continue;
    }
    if ((tok = tokFences(src))) { src = src.slice(tok.raw.length); nodes.push(tok); continue; }
    if ((tok = tokHeading(src))) { src = src.slice(tok.raw.length); nodes.push(tok); continue; }
    if ((tok = tokHr(src))) { src = src.slice(tok.raw.length); nodes.push(tok); continue; }
    if ((tok = tokBlockquote(src, ctx))) { src = src.slice(tok.raw.length); nodes.push(tok); continue; }
    if ((tok = tokList(src, ctx))) { src = src.slice(tok.raw.length); nodes.push(tok); continue; }
    if ((tok = tokHtml(src))) { src = src.slice(tok.raw.length); nodes.push(tok); continue; }
    if ((tok = tokDef(src))) {
      src = src.slice(tok.raw.length);
      const prev = nodes.at(-1);
      if (prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
      } else {
        if (!ctx.links.has(tok.tag)) ctx.links.set(tok.tag, { href: tok.href, title: tok.title });
        nodes.push(tok);
      }
      continue;
    }
    if ((tok = tokTable(src))) { src = src.slice(tok.raw.length); nodes.push(tok); continue; }
    if ((tok = tokLheading(src))) { src = src.slice(tok.raw.length); nodes.push(tok); continue; }
    if (top && (tok = tokParagraph(src))) {
      const prev = nodes.at(-1);
      if (mergePara && prev && prev.t === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
      } else nodes.push(tok);
      mergePara = false;
      src = src.slice(tok.raw.length);
      continue;
    }
    if ((tok = tokText(src))) {
      src = src.slice(tok.raw.length);
      const prev = nodes.at(-1);
      if (prev && prev.t === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
      } else nodes.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return nodes;
}

// ---- inline rendering --------------------------------------------------------
// Renders an inline source string straight to HTML while scanning, following
// marked's dispatch order: escape, raw tag, inline link, reference link,
// emphasis, code span, hard break, strikethrough, autolink, extended
// autolink, plain text. `ctx` carries the shared lexer state (inLink,
// inRawBlock, linkEmitted, linkParenPossible) plus the link definitions.
// In `plain` mode (image alt text) the same lexing runs but markup is
// dropped and only the text survives.
function scanCloserRuns(s) {
  const last = { '*': -1, '_': -1 };
  let del = -1;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const ch = s[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : s[i - 1];
    let j = i + 1;
    while (j < n && s[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i; else last[ch] = i;
    }
    i = j - 1;
  }
  return { star: last['*'], und: last['_'], del };
}
function linkInText(s, ctx) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(BLOCK_SKIP_RE)) {
    if (INLINE_LINK_RE.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(REFLINK_SEARCH_RE)) {
    const str = m[0], r = str.lastIndexOf('[');
    if (!(str.charAt(0) === '!' || !ctx.links.has(normalizeLabel(str.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(str.slice(1, r - 1), ctx))) return true;
  }
  return false;
}
// Mask links / code spans / inline HTML in a copy of the source, keeping
// every character position, so the emphasis scanner cannot mistake a closer
// inside link text for a real closer.
function maskEmStrong(src, ctx) {
  let t = src;
  if (ctx.links.size > 0 && src.includes('[')) {
    const maskReflink = (r) => {
      const o = r.lastIndexOf('[');
      if (!ctx.links.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, ctx)) return '[' + inner.replace(REFLINK_SEARCH_RE, maskReflink) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH_RE, maskReflink);
  }
  if (src.includes('\\') || src.includes('`')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (n, s, r) => {
      if (r) return '+'.repeat(n.length);
      if (s) return s + n.slice(s.length, -s.length).replace(/`/g, '+') + s;
      return n;
    });
  }
  // blockSkip also masks code spans and <tags>, not just [...] links.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    t = t.replace(BLOCK_SKIP_RE, n => '[' + 'a'.repeat(n.length - 2) + ']');
  }
  return t;
}
function linkHasTagBeyond(full, labelText, off) {
  if (!labelText.includes('<')) return false;
  for (let i = 0; i < labelText.length; i++) {
    if (labelText[i] === '\\') { i++; continue; }
    if (labelText[i] === '`') {
      const code = INLINE_CODE_RE.exec(labelText.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (labelText[i] !== '<') continue;
    const tail = full.slice(off + i);
    const tag = INLINE_TAG_RE.exec(tail) || AUTOLINK_RE.exec(tail);
    if (tag) {
      if (tag[0].length > labelText.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}
// Create a link/image from a parsed label + destination (marked's link
// builder). Returns the HTML string, or null when the label itself contains
// a link, which rejects the outer link.
function makeLink(label, href, title, isImage, ctx) {
  const text = label.replace(reOutputLinkReplace, '$1');
  const savedInLink = ctx.inLink, savedEmitted = ctx.linkEmitted, savedRaw = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = renderInline(text, ctx);
  const innerHasLink = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  if (!isImage) {
    if (innerHasLink) { ctx.inRawBlock = savedRaw; return null; }
    ctx.linkEmitted = true;
    if (ctx.plain) return inner;
    const url = cleanUrl(href);
    if (url === null) return inner;
    let out = '<a href="' + escapeHtml(url, false) + '"';
    if (title) out += ' title="' + escapeHtml(title, false) + '"';
    return out + '>' + inner + '</a>';
  }
  const alt = renderInlinePlain(text, ctx.links);
  if (ctx.plain) return alt;
  const url = cleanUrl(href);
  if (url === null) return escapeHtml(alt, false);
  let out = '<img src="' + escapeHtml(url, false) + '" alt="' + escapeHtml(alt, false) + '"';
  if (title) out += ' title="' + escapeHtml(title, false) + '"';
  return out + '>';
}
function renderAutolink(text, href, ctx) {
  if (ctx.plain) return text;
  const inner = escapeHtml(text, true);
  const url = cleanUrl(href);
  if (url === null) return inner;
  return '<a href="' + escapeHtml(url, true) + '">' + inner + '</a>';
}
function tryInlineLink(rest, m, ctx) {
  let raw = m[0], label = m[1], href = m[2], title = m[3];
  const off = raw.charAt(0) === '!' ? 2 : 1;
  if (linkHasTagBeyond(rest, label, off)) return null;
  const s = href.trim();
  if (reStartAngle.test(s)) {
    if (!reEndAngle.test(s)) return null;
    const l = stripTail(s.slice(0, -1), '\\', false);
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = findUnmatchedClose(href, '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (raw.indexOf('!') === 0 ? 5 : 4) + label.length + l;
      href = href.substring(0, l);
      raw = raw.substring(0, h).trim();
      title = '';
    }
  }
  const r = stripTail(raw.slice(0, -1), '\\', false);
  if ((raw.length - r.length) % 2 === 0) return null;
  let dest = href.trim();
  const titleText = title ? title.slice(1, -1) : '';
  if (reStartAngle.test(dest)) dest = dest.slice(1, -1);
  const html = makeLink(label, dest.replace(ANY_PUNCT_RE, '$1'), titleText.replace(ANY_PUNCT_RE, '$1'), raw.charAt(0) === '!', ctx);
  if (html === null) return null;
  return { html, len: raw.length };
}
function tryEmStrong(rest, masked, pos, prev, ctx, maskInfo) {
  const m = EM_LDELIM_RE.exec(rest);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const prevIsDelim = prev === delim;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || PUNCT_START_RE.test(p);
  if (l < i) prev = p;
  const u = l < i ? h : PUNCT_START_RE.test(prev);
  if (m[4] && ALPHA_NUM.test(prev)) return null;
  const d = m[1] || m[3] || '';
  if (!d || !prev || u) {
    const k = [...m[0]].length - 1;
    let g, b, mm = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (delim === '*' && !h));
    if (delim !== '*' && delim !== '_') return null;
    const re = delim === '*' ? EM_RDELIM_AST_RE : EM_RDELIM_UND_RE;
    const v = delim === '*' ? maskInfo.star : maskInfo.und;
    const Q = i + k;
    if (v < Q) return null;
    const slice = masked.slice(i + k);
    const ee = v - Q;
    re.lastIndex = 0;
    let s;
    while ((s = re.exec(slice)) !== null && !(s.index > ee)) {
      g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      b = [...g].length;
      if (s[3] || s[4]) { mm += b; continue; }
      else if (s[5] || s[6] || R) {
        if (prevIsDelim && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      mm -= b;
      if (mm > 0) continue;
      b = Math.min(b, b + mm + f);
      const te = [...s[0]][0].length;
      const M = rest.slice(0, k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const inner = M.slice(1, -1);
        const html = ctx.plain ? renderInline(inner, ctx) : '<em>' + renderInline(inner, ctx) + '</em>';
        return { html, len: M.length };
      }
      const inner = M.slice(2, -2);
      const html = ctx.plain ? renderInline(inner, ctx) : '<strong>' + renderInline(inner, ctx) + '</strong>';
      return { html, len: M.length };
    }
  }
  return null;
}
function tryDel(rest, masked, pos, prev, ctx, maskInfo) {
  const m = DEL_LDELIM_RE.exec(rest);
  if (!m) return null;
  if (!((m[1] || '') || !prev || PUNCT_START_RE.test(prev))) return null;
  const o = [...m[0]].length - 1;
  let i, l, p = o;
  const u = maskInfo.del;
  const d = pos + o;
  if (u < d) return null;
  const slice = masked.slice(pos + o);
  const kk = u - d;
  DEL_RDELIM_RE.lastIndex = 0;
  let s;
  while ((s = DEL_RDELIM_RE.exec(slice)) !== null && !(s.index > kk)) {
    i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!i || (l = [...i].length, l !== o)) continue;
    if (s[3] || s[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    l = Math.min(l, l + p);
    const g = [...s[0]][0].length;
    const b = rest.slice(0, o + s.index + g + l);
    const inner = b.slice(o, -o);
    const html = ctx.plain ? renderInline(inner, ctx) : '<del>' + renderInline(inner, ctx) + '</del>';
    return { html, len: b.length };
  }
  return null;
}
function renderInlineInner(src, ctx) {
  // Without *, _ or ~ no emphasis/delimiter can ever match, so the whole
  // masking pass and the closer scan are skipped.
  const hasEm = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasEm ? maskEmStrong(src, ctx) : src;
  const maskInfo = hasEm ? scanCloserRuns(masked) : { star: -1, und: -1, del: -1 };
  let out = '';
  let rest = src;
  let prev = '';
  let hadText = false;
  let guard = Infinity;
  while (rest) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    if (!hadText) prev = '';
    hadText = false;
    const pos = src.length - rest.length;
    let m;
    // Fast path: most run starts are ordinary characters that cannot begin
    // any inline construct, so the whole dispatch is skipped and the text
    // regex runs directly. A possible URL start is checked separately.
    const ch = rest[0];
    // A URL/email can only start with a letter, digit, or . _ + - .
    const maybeUrl = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '+' || ch === '-';
    const maybeSpecial = ch === '\\' || ch === '<' || ch === '[' || ch === '!' || ch === '*' || ch === '_' || ch === '`' || ch === '~' || (ch === ' ' && rest[1] === ' ') || (maybeUrl && URL_START_RE.test(rest));
    if (maybeSpecial && (m = INLINE_ESCAPE_RE.exec(rest))) {
      out += ctx.plain ? m[1] : escapeHtml(m[1], false);
      rest = rest.slice(m[0].length);
      continue;
    }
    if (maybeSpecial && (m = INLINE_TAG_RE.exec(rest))) {
      if (!ctx.inLink && reStartATag.test(m[0])) ctx.inLink = true;
      else if (ctx.inLink && reEndATag.test(m[0])) ctx.inLink = false;
      if (!ctx.inRawBlock && reStartPreTag.test(m[0])) ctx.inRawBlock = true;
      else if (ctx.inRawBlock && reEndPreTag.test(m[0])) ctx.inRawBlock = false;
      out += m[0];
      rest = rest.slice(m[0].length);
      continue;
    }
    if (maybeSpecial && ctx.linkParenPossible && (m = INLINE_LINK_RE.exec(rest))) {
      const res = tryInlineLink(rest, m, ctx);
      if (res) { out += res.html; rest = rest.slice(res.len); continue; }
    }
    if (maybeSpecial && ((m = REFLINK_RE.exec(rest)) || (m = NOLINK_RE.exec(rest)))) {
      const isImage = m[0].charAt(0) === '!';
      const off = isImage ? 2 : 1;
      let done = false;
      if (!linkHasTagBeyond(rest, m[1], off)) {
        const ref = ctx.links.get(normalizeLabel(m[2] || m[1]));
        if (!ref) {
          out += m[0].charAt(0);
          prev = m[0].charAt(0);
          hadText = true;
          rest = rest.slice(1);
          done = true;
        } else {
          const html = makeLink(m[1], ref.href, ref.title, isImage, ctx);
          if (html !== null) { out += html; rest = rest.slice(m[0].length); done = true; }
        }
      }
      if (done) continue;
    }
    if (hasEm) {
      const em = tryEmStrong(rest, masked, pos, prev, ctx, maskInfo);
      if (em) { out += em.html; rest = rest.slice(em.len); continue; }
    }
    if (maybeSpecial && (m = INLINE_CODE_RE.exec(rest))) {
      let text = m[2].replace(reNewlineGlobal, ' ');
      if (reNonSpace.test(text) && reStartingSpace.test(text) && reEndingSpace.test(text)) text = text.substring(1, text.length - 1);
      out += ctx.plain ? text : '<code>' + escapeHtml(text, true) + '</code>';
      rest = rest.slice(m[0].length);
      continue;
    }
    if (maybeSpecial && (m = INLINE_BR_RE.exec(rest))) {
      out += ctx.plain ? '' : '<br>';
      rest = rest.slice(m[0].length);
      continue;
    }
    if (hasEm) {
      const del = tryDel(rest, masked, pos, prev, ctx, maskInfo);
      if (del) { out += del.html; rest = rest.slice(del.len); continue; }
    }
    if (maybeSpecial && (m = AUTOLINK_RE.exec(rest))) {
      let text, href;
      if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
      else { text = m[1]; href = text; }
      out += ctx.plain ? text : renderAutolink(text, href, ctx);
      rest = rest.slice(m[0].length);
      continue;
    }
    if (maybeSpecial && !ctx.inLink && (m = URL_RE.exec(rest))) {
      let text, href;
      if (m[2] === '@') { text = m[0]; href = 'mailto:' + text; }
      else {
        let cur = m[0], prev2;
        do { prev2 = cur; cur = BACKPEDAL_RE.exec(cur)?.[0] ?? ''; } while (prev2 !== cur);
        text = cur;
        href = m[1] === 'www.' ? 'http://' + cur : cur;
      }
      out += ctx.plain ? text : renderAutolink(text, href, ctx);
      rest = rest.slice(text.length);
      continue;
    }
    if ((m = INLINE_TEXT_RE.exec(rest))) {
      const chunk = m[0];
      out += ctx.inRawBlock ? chunk : (ctx.plain ? decodeEntities(chunk) : escapeHtml(decodeEntities(chunk), false));
      if (chunk.slice(-1) !== '_') prev = chunk.slice(-1);
      hadText = true;
      rest = rest.slice(chunk.length);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  return out;
}
function renderInline(src, ctx) {
  const saved = ctx.linkParenPossible;
  ctx.linkParenPossible = saved && src.includes(')');
  try {
    return renderInlineInner(src, ctx);
  } finally {
    ctx.linkParenPossible = saved;
  }
}
// Top-level inline parse for one block's content: raw-block state never
// carries over from the previous block.
function renderInlineTop(src, ctx) {
  ctx.inRawBlock = false;
  return renderInline(src, ctx);
}
function renderInlinePlain(src, links) {
  const fresh = { links, inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, plain: true };
  return renderInline(src, fresh);
}
function renderCheckbox(box) {
  return '<input ' + (box.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}
function renderTableCell(cell, isHeader, ctx, out) {
  const tag = isHeader ? 'th' : 'td';
  out.push((cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + renderInlineTop(cell.text, ctx) + `</${tag}>\n`);
}
function renderBlocks(nodes, ctx, out) {
  for (const node of nodes) {
    switch (node.t) {
      case 'space': case 'def': break;
      case 'hr': out.push('<hr>\n'); break;
      case 'heading':
        out.push(`<h${node.depth}>${renderInlineTop(node.text, ctx)}</h${node.depth}>\n`);
        break;
      case 'code': {
        const lang = node.lang || '';
        const s = lang.match(reNotSpaceStart)?.[0] || '';
        const r = node.text ? node.text.replace(reEndingNewline, '') + '\n' : '';
        if (s) out.push(`<pre><code class="language-${escapeHtml(s, false)}">${escapeHtml(r, true)}</code></pre>\n`);
        else out.push(`<pre><code>${escapeHtml(r, true)}</code></pre>\n`);
        break;
      }
      case 'table': {
        const head = [];
        for (const cell of node.header) renderTableCell(cell, true, ctx, head);
        let body = '';
        for (const row of node.rows) {
          const cells = [];
          for (const cell of row) renderTableCell(cell, false, ctx, cells);
          body += `<tr>\n${cells.join('')}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out.push(`<table>\n<thead>\n<tr>\n${head.join('')}</tr>\n</thead>\n${body}</table>\n`);
        break;
      }
      case 'blockquote':
        out.push('<blockquote>\n');
        renderBlocks(node.nodes, ctx, out);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul';
        const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
        let items = '';
        for (const item of node.items) {
          let inner = '';
          if (item.checkboxFirst) inner += renderCheckbox(item.checkboxFirst);
          const parts = [];
          renderBlocks(item.nodes, ctx, parts);
          inner += parts.join('');
          items += `<li>${inner}</li>\n`;
        }
        out.push(`<${tag}${start}>\n${items}</${tag}>\n`);
        break;
      }
      case 'html': out.push(node.text); break;
      case 'paragraph': {
        let inner = renderInlineTop(node.text, ctx);
        if (node.checkbox) inner = renderCheckbox(node.checkbox) + inner;
        out.push(`<p>${inner}</p>\n`);
        break;
      }
      case 'text': {
        let inner = renderInlineTop(node.text, ctx);
        if (node.checkbox) inner = renderCheckbox(node.checkbox) + inner;
        out.push(inner);
        break;
      }
    }
  }
}
export function parse(markdown) {
  const src = markdown.replace(reCarriageReturn, '\n');
  const ctx = { links: new Map(), inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, plain: false };
  const nodes = [];
  lexBlocks(src, true, nodes, ctx, false);
  const out = [];
  renderBlocks(nodes, ctx, out);
  return out.join('');
}
