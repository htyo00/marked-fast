// Driver for the marked-fast entry. The harness runs `node /bot/main.ts`.
// It reads the case list, renders every case alone through parse() from
// parse.js, and writes the HTML strings back in the same order.
// Outside a container the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR variables
// stand in for /input and /output.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inDir, 'cases.json'), 'utf8');
const list = JSON.parse(raw) as Array<{ id: string; markdown: string }>;

const rendered: string[] = new Array(list.length);
for (let k = 0; k < list.length; k++) rendered[k] = parse(list[k].markdown);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));
