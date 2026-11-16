// marked-faster driver: read cases.json, render each case alone with
// parse() from parse.js, write the HTML strings in order to html.json.
// Node builtins only; no network; deterministic.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8'));
// Pre-size the output array (no push/grow churn) and fast-path empty
// inputs: marked renders an empty document as an empty string, so there
// is nothing for parse() to do for those cases.
const html = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  const md = cases[k].markdown;
  html[k] = md ? parse(md) : '';
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(html));
