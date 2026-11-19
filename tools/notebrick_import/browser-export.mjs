// Import this module in the browser tool's Node REPL; pass its documented Tab handle.
// No cookies, storage, credentials, app internals or direct HTTP requests are read here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const CHUNK = 100000;
const sha = value => createHash('sha256').update(value).digest('hex');
async function json(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}
async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, value);
  await fs.rename(temporary, file);
}
function valid(value, field) {
  return value && Array.isArray(value[field]) && (field !== 'blocks' || value[field].length > 0)
    && !JSON.stringify(value).includes('[MaxDepth]') && !JSON.stringify(value).includes('[Truncated]');
}

export async function captureResource({ tab, url, output, field, maxChunks = 2 }) {
  if (valid(await json(output), field)) return { complete: true, cached: true, output };
  if (await tab.url() !== url) await tab.goto(url);
  const first = await tab.playwright.evaluate(() => document.body.innerText.slice(0, 100000));
  if (!first.trimStart().startsWith('{')) throw new Error('The logged-in source page did not return note JSON. Check the page/login.');
  const checkpoint = output + '.capture';
  await fs.mkdir(checkpoint, { recursive: true });
  let state = await json(path.join(checkpoint, 'state.json'));
  const firstHash = sha(first);
  if (!state || state.url !== url || state.firstHash !== firstHash) {
    state = { url, firstHash, parts: 1, complete: first.length < CHUNK };
    await atomic(path.join(checkpoint, '0.txt'), first);
    await atomic(path.join(checkpoint, 'state.json'), JSON.stringify(state));
  }
  for (let index = 0; index < maxChunks && !state.complete; index++) {
    const start = state.parts * CHUNK;
    const part = await tab.playwright.evaluate(
      ({ start, end }) => document.body.innerText.slice(start, end), { start, end: start + CHUNK },
    );
    await atomic(path.join(checkpoint, state.parts + '.txt'), part);
    state.parts++;
    state.complete = part.length < CHUNK;
    await atomic(path.join(checkpoint, 'state.json'), JSON.stringify(state));
  }
  if (!state.complete) return { complete: false, output, chunks: state.parts };
  const parts = [];
  for (let index = 0; index < state.parts; index++) parts.push(await fs.readFile(path.join(checkpoint, index + '.txt'), 'utf8'));
  const value = JSON.parse(parts.join(''));
  if (!valid(value, field)) throw new Error('Source export is incomplete: ' + field);
  await atomic(output, JSON.stringify(value, null, 2) + '\n');
  return { complete: true, output, chunks: state.parts };
}

function hasFigures(value) {
  if (Array.isArray(value)) return value.some(hasFigures);
  return value && typeof value === 'object' && (value.t === 'fig' || value.kind === 'fig' || Object.values(value).some(hasFigures));
}

export async function captureNote({ tab, jobId, sourceDirectory, maxChunks = 2 }) {
  if (!/^[a-f0-9]{24,64}$/.test(jobId)) throw new Error('Invalid NoteBrick job ID');
  const base = 'https://notebrick.cn/app/api/jobs/' + jobId;
  const output = path.join(sourceDirectory, jobId + '.json');
  let original = await json(output);
  if (!valid(original, 'blocks')) {
    const result = await captureResource({ tab, url: base + '/edit?mode=detailed', output, field: 'blocks', maxChunks });
    // One resource per REPL call keeps RPC duration bounded and resumes cleanly.
    return { ...result, complete: false, stage: result.complete ? 'source-saved' : 'source-pending', jobId };
  }
  if (!hasFigures(original.blocks)) return { complete: true, stage: 'done', jobId };
  const result = await captureResource({ tab, url: base + '/edit/places?mode=detailed',
    output: path.join(sourceDirectory, jobId + '-places.json'), field: 'places', maxChunks });
  return { ...result, stage: result.complete ? 'done' : 'positions-pending', jobId };
}
