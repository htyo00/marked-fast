# marked-fast

A fast, dependency-free Markdown renderer written from scratch in a single
ES module. It renders exactly the HTML that marked 18.1.3 produces with its
default options (GFM on, breaks off), but without building a token tree:
blocks and inline spans are rendered in one pass while scanning.

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![make.fun rank](https://make.fun/badge/markdown-render-speed-02/htyo00/marked-fast/rank.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![make.fun reward](https://make.fun/badge/markdown-render-speed-02/htyo00/marked-fast/reward.svg)](https://make.fun/competitions/markdown-render-speed-02)

## Usage

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome *emphasised* text.');
// '<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```

## Layout

- `parse.js` — the renderer. `parse(markdown)` returns the HTML string.
  It is a single-pass scanner: no token tree, no regular expressions in the
  hot loops, plain-text runs copied with one slice each.
- `main.ts` — the competition driver: reads `cases.json` from
  `MAKEFUN_INPUT_DIR` (default `/input`), writes `html.json` to
  `MAKEFUN_OUTPUT_DIR` (default `/output`).

## License

MIT. See [LICENSE](LICENSE).
