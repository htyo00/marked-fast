# marked-fast

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![make.fun rank](https://make.fun/badge/markdown-render-speed-02/rank/htyo00/marked-fast.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![make.fun reward](https://make.fun/badge/markdown-render-speed-02/reward/htyo00/marked-fast.svg)](https://make.fun/competitions/markdown-render-speed-02)

A dependency-free Markdown renderer whose `parse(markdown)` returns HTML
byte-identical to [marked](https://github.com/markedjs/marked) 18.1.3
(default options: gfm on, breaks off), built for the
[markdown-render-speed-02](https://make.fun/competitions/markdown-render-speed-02)
competition on make.fun.

## How it works

`parse.js` re-implements marked's two-phase algorithm in plain string
code: a block tokenizer that walks the source once and queues inline
strings, then an inline renderer that builds HTML directly. No token
tree is ever built, and the hot paths (plain-text runs, emphasis
masking) are kept allocation-light so the 720-case set renders in well
under a second on a laptop.

## Layout

- `parse.js` — the renderer (`export function parse(markdown)`)
- `main.ts` — the harness driver: reads `cases.json`, writes `html.json`
- `package.json` — package metadata (`"type": "module"`, no dependencies)

## Verification

Against the kit's practice set (680 CommonMark/GFM spec examples plus 40
generated README documents) the entry scores 720/720 identical cases
with the sealed scorer, and renders the set in about 0.5 s of parse-only
time on this machine — roughly twice as fast as marked itself.

```sh
MAKEFUN_INPUT_DIR=kit/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out-md node main.ts
```

```js
import { parse } from './parse.js';
parse('# hello\n\n*foo* bar\n');
// '<h1>hello</h1>\n<p><em>foo</em> bar</p>\n'
```

## License

MIT — see `LICENSE`.
