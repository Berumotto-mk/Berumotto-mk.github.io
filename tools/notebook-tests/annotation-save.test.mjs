import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from '../../static/notes/_shared/vendor/purify.es.mjs';
import katex from '../../static/notes/_shared/vendor/katex.mjs';

const shared = new URL('../../static/notes/_shared/', import.meta.url);
const html = await fs.readFile(new URL('../../static/notes/reinforcement-learning/index.html', import.meta.url), 'utf8');
let script = '';
for (const name of ['heading-numbering.js', 'sidebar-resize.js', 'annotations.js', 'notebook-app.js']) {
  script += (await fs.readFile(new URL(name, shared), 'utf8')).replace(/^import .*$/gm, '').replaceAll('export function ', 'function ') + '\n';
}
const config = { title: 'Test course', repository: 'example/notes', branch: 'main', directory: 'static/notes/test', draftKey: 'test-draft:', collapseKey: 'test-collapsed' };
const first = { id: 'note-a', sourceId: 'a'.repeat(32), title: 'First note', date: '2026-11-20', html: '<div data-block="one"><h2>Chapter</h2><p>alpha <strong>beta</strong> gamma</p><span class="math" data-latex="x^2" data-display="false" contenteditable="false">x^2</span></div>' };
const second = { id: 'note-b', sourceId: 'b'.repeat(32), title: 'Second note', date: '2026-11-20', html: '<div data-block="two"><h2>Another chapter</h2><p>Another lesson</p></div>' };
const notes = { 'note-a': first, 'note-b': second };
const remote = structuredClone(notes);
const dom = new JSDOM(html, { url: 'https://example.test/notes/test/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.structuredClone = structuredClone; w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
w.IntersectionObserver = class { observe() {} disconnect() {} };
w.HTMLElement.prototype.scrollIntoView = function () {};
w.Range.prototype.getBoundingClientRect = () => ({ left: 300, top: 300, bottom: 320, width: 100, height: 20 });
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
w.testPurify = createDOMPurify(w);
w.testKatex = { render: (value, element, options) => { element.innerHTML = katex.renderToString(value, options); } };
const response = data => ({ ok: true, json: async () => structuredClone(data) });
let commits = 0;
w.fetch = async (url, options = {}) => {
  if (url === './data/manifest.json') return response([first, second].map(n => ({ id: n.id, title: n.title })));
  if (url.startsWith('./data/')) return response(notes[url.split('/').at(-1).replace('.json', '')]);
  if (url === 'https://api.github.com/repos/example/notes') return response({ permissions: { push: true } });
  assert.ok(url.includes('/contents/static/notes/test/data/'));
  const identifier = url.match(/(note-[ab])\.json/)[1];
  if (options.method === 'PUT') {
    const payload = JSON.parse(options.body);
    remote[identifier] = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8'));
    commits++;
    return response({ commit: { sha: 'commit-' + commits } });
  }
  return response({ sha: 'sha-' + commits, content: Buffer.from(JSON.stringify(remote[identifier])).toString('base64') });
};
w.eval('const DOMPurify = window.testPurify; const katex = window.testKatex;\n' + script + '\nstartNotebook(' + JSON.stringify(config) + ');');
const wait = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
const $ = id => w.document.getElementById(id);
function selectFirstWord() {
  let node = $('body').querySelector('p').firstChild;
  while (node.firstChild) node = node.firstChild;
  const range = w.document.createRange(); range.setStart(node, 0); range.setEnd(node, 5);
  w.getSelection().removeAllRanges(); w.getSelection().addRange(range);
  w.document.dispatchEvent(new w.Event('selectionchange'));
}
function color(type, name) {
  const toolbar = w.document.querySelector('.annotation-floating');
  toolbar.querySelector('[aria-label="' + (type === 'highlight' ? '荧光笔颜色' : '文字颜色') + '"]').click();
  w.document.querySelector('[aria-label="' + (type === 'highlight' ? '荧光笔：' : '字色：') + name + '"]').click();
}
try {
  await wait();
  assert.equal($('save').disabled, true, 'Loading must not create a draft');
  selectFirstWord(); color('highlight', '黄色'); color('color', '红色'); await wait(550);
  assert.equal($('read').getAttribute('aria-pressed'), 'true');
  assert.ok($('body').querySelector('[data-note-highlight="yellow"][data-note-color="red"]'));
  assert.equal($('body').querySelector('.math').dataset.latex, 'x^2');
  assert.equal($('body').querySelectorAll('.katex-error').length, 0);
  assert.match(w.localStorage.getItem('test-draft:note-a'), /data-note-highlight/);
  w.location.hash = 'lesson=note-b'; await wait();
  assert.equal($('body').querySelectorAll('.note-annotation').length, 0);
  w.location.hash = 'lesson=note-a'; await wait();
  assert.ok($('body').querySelector('[data-note-color="red"]'), 'Switching lessons restores the annotation draft');
  $('connect').click(); $('token').value = 'dummy-test-token'; $('authorize').click(); await wait();
  $('save').click(); await wait();
  assert.equal(commits, 1);
  assert.match(remote['note-a'].html, /data-note-highlight="yellow"/);
  assert.match(remote['note-a'].html, /data-note-color="red"/);
  assert.ok(!remote['note-a'].html.includes('style='), 'Colors must persist without allowing arbitrary inline styles');
  assert.ok(!remote['note-a'].html.includes('data-heading-number'));
  assert.equal(w.localStorage.getItem('test-draft:note-a'), null);
  selectFirstWord(); color('highlight', '蓝色'); await wait(550);
  remote['note-a'].html += '<p>Another device changed the note</p>';
  $('save').click(); await wait();
  assert.equal(commits, 1, 'Concurrent remote edits must not be overwritten');
  assert.match($('status').textContent, /另一设备/);
  assert.match(w.localStorage.getItem('test-draft:note-a'), /data-note-highlight/);
  assert.equal($('token').value, '');
  for (const value of Object.values(w.localStorage)) assert.ok(!value.includes('dummy-test-token'));
  console.log('PASS: read-mode annotation, draft recovery, sanitized GitHub payload, formulas and remote conflict protection.');
} finally {
  dom.window.close();
}
