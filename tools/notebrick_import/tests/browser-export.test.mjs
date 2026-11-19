// Offline harness test: no browser, authentication or network is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { captureResource, captureNote } from '../browser-export.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notebrick-checkpoint-'));
const jobId = 'a'.repeat(32);
const output = path.join(directory, jobId + '.json');
const base = 'https://notebrick.cn/app/api/jobs/' + jobId;
let original = { title: 'Long note', version: 1, blocks: [
  { id: 'paragraph', kind: 'paragraph', read: { body: [{ t: 'p', c: [{ t: 'text', v: 'A'.repeat(350000) }] }] } },
  { id: 'image', kind: 'fig', read: { images: [{ path: 'diagram.svg' }] } },
] };
let calls = 0;
function fakeTab() {
  let current;
  return {
    url: async () => current,
    goto: async url => { current = url; },
    playwright: { evaluate: async (fn, argument) => {
      calls++;
      const text = current.includes('/places?') ? JSON.stringify({ places: [{ id: 'image', page: 1, x: 60, y: 100 }] }) : JSON.stringify(original);
      const value = vm.runInNewContext('(' + fn.toString() + ')(argument)', { document: { body: { innerText: text } }, argument });
      // Simulate the browser transport's limit that previously truncated full strings.
      return typeof value === 'string' ? value.slice(0, 200000) : value;
    } },
  };
}
try {
  let tab = fakeTab();
  let result = await captureResource({ tab, url: base + '/edit?mode=detailed', output, field: 'blocks', maxChunks: 1 });
  assert.equal(result.complete, false);
  // Reconnect and change the source version mid-export; old chunks must not mix in.
  tab = fakeTab();
  original = structuredClone(original);
  original.version = 2;
  original.blocks[0].read.body[0].c[0].v = 'B'.repeat(350000);
  for (let attempt = 0; attempt < 5 && !result.complete; attempt++) {
    result = await captureResource({ tab, url: base + '/edit?mode=detailed', output, field: 'blocks', maxChunks: 1 });
  }
  assert.equal(result.complete, true);
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), original);
  result = await captureNote({ tab, jobId, sourceDirectory: directory });
  assert.equal(result.complete, true);
  const before = calls;
  assert.equal((await captureNote({ tab, jobId, sourceDirectory: directory })).complete, true);
  assert.equal(calls, before, 'Complete checkpoints must not reread the browser');
  await assert.rejects(captureNote({ tab, jobId: '../escape', sourceDirectory: directory }), /Invalid/);
  console.log('PASS: long JSON, resumed connection, source-version changes, positions and completed checkpoints.');
} finally {
  // This directory was created by this test inside os.tmpdir().
  assert.ok(directory.startsWith(path.join(os.tmpdir(), 'notebrick-checkpoint-')));
  await fs.rm(directory, { recursive: true, force: true });
}
