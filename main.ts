// Driver for markdown-render-speed-02: read every case, render it with
// parse.js, and write the HTML strings back in the cases' order.
// The harness runs `node main.ts` with /input and /output mounted; outside
// a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
