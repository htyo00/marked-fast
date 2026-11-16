// Driver for markdown-render-speed-02: reads every case from the input
// directory, renders each one alone with parse() from parse.js, and writes
// the HTML strings, in case order, as a JSON array to the output directory.
// The harness runs this as `node /bot/main.ts` on Node 22 (type stripping,
// so only erasable TypeScript syntax is used here). Outside a container the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR variables stand in for /input and
// /output; when they are absent the container paths are used.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const rawText = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(rawText) as { id: string; markdown: string }[];

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  // Each case is rendered in isolation, exactly as the harness expects:
  // no state is shared between cases.
  rendered[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
