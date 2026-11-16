# marked-fast

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/htyo00/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/htyo00/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free Markdown renderer whose `parse(markdown)` returns
exactly the HTML that [marked](https://github.com/markedjs/marked) 18.1.3
renders with its default options (GitHub Flavored Markdown on).

## Design

Single-pass, no token tree: a block scanner dispatches on the first
characters of each line and an inline scanner renders straight into an
output array, so there is no intermediate tree to allocate or walk a second
time. Hot paths (lists, code spans, links, emphasis) are hand-rolled
character scans instead of regular expressions.

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome *emphasis*.');
```

## Files

- `parse.js` — the renderer (dependency-free ES module).
- `main.ts` — the harness driver: reads `cases.json`, writes `html.json`.
