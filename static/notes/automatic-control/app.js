import DOMPurify from './vendor/purify.es.mjs';
import katex from './vendor/katex.mjs';

// A trailing escaped space is significant in LaTeX and must survive sanitizing.
DOMPurify.addHook('uponSanitizeAttribute', (node, attribute) => {
  if (attribute.attrName === 'data-latex') attribute.attrValue = node.getAttribute('data-latex');
});

const $ = id => document.getElementById(id);
const repository = 'Berumotto-mk/Berumotto-mk.github.io';
const branch = 'main';
const apiRoot = `https://api.github.com/repos/${repository}`;
const storagePrefix = 'automatic-control-note-draft-v1:';
let lessons = [];
let current = null;
let baseline = null;
let token = '';
let editing = false;
let busy = false;
let generation = 0;
let changed = false;
let draftTimer;
let observer;
let formulaTarget;
let insertionRange;

function status(message) { $('status').textContent = message; }
function displayLatex(value) {
  return (value.match(/\\tag\{/g) || []).length > 1
    ? value.replace(/\\tag\{([^}]+)\}/g, '\\quad\\text{($1)}') : value;
}
function clean(html) {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['contenteditable', 'data-latex', 'data-display', 'data-kind', 'data-block', 'data-math-source'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'style'],
    FORBID_ATTR: ['style', 'onerror', 'onclick'],
  });
}
function normalize(note) {
  const container = document.createElement('div');
  container.innerHTML = clean(note.html);
  for (const heading of container.querySelectorAll('h2,h3,h4')) heading.removeAttribute('id');
  for (const element of container.querySelectorAll('.math[data-latex]')) {
    element.textContent = element.dataset.latex;
    element.contentEditable = 'false';
    element.removeAttribute('tabindex');
    element.removeAttribute('title');
  }
  return { ...note, html: clean(container.innerHTML) };
}
function prepareMath(root) {
  for (const element of root.querySelectorAll('.math[data-latex]')) {
    element.contentEditable = 'false';
    element.tabIndex = 0;
    element.title = '双击编辑 LaTeX 公式';
    katex.render(displayLatex(element.dataset.latex), element, {
      throwOnError: false, strict: false, trust: false,
      displayMode: element.dataset.display === 'true', output: 'htmlAndMathml',
    });
  }
}
function content() {
  const copy = $('body').cloneNode(true);
  for (const element of copy.querySelectorAll('.math[data-latex]')) {
    element.textContent = element.dataset.latex;
    element.removeAttribute('tabindex');
    element.removeAttribute('title');
  }
  for (const heading of copy.querySelectorAll('h2,h3,h4')) heading.removeAttribute('id');
  return { ...current, html: clean(copy.innerHTML) };
}
function same(a, b) { return a?.html === b?.html && a?.title === b?.title; }
function rememberDraft() {
  if (!current) return;
  const value = content();
  changed = !same(value, baseline);
  try {
    if (changed) localStorage.setItem(storagePrefix + current.id, JSON.stringify({ note: value, base: baseline, savedAt: Date.now() }));
    else localStorage.removeItem(storagePrefix + current.id);
    status(changed ? '草稿已保存在此浏览器' : token ? '已与 GitHub 内容一致' : '已载入笔记');
  } catch { status('浏览器草稿存储已满，请导出备份'); }
  $('save').disabled = busy || !changed;
}
function onInput() {
  changed = true;
  $('save').disabled = busy;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { rememberDraft(); outline(); }, 450);
}
function outline() {
  observer?.disconnect();
  $('toc').replaceChildren();
  const headings = [...$('body').querySelectorAll('h2,h3,h4')].filter(heading => !heading.closest('section.callout') && heading.dataset.kind !== 'group');
  headings.forEach((heading, index) => {
    heading.id = `section-${index + 1}`;
    const link = document.createElement('a');
    link.href = `#${heading.id}`;
    link.textContent = heading.textContent;
    link.dataset.level = heading.tagName.slice(1);
    link.addEventListener('click', event => {
      event.preventDefault(); heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('toc').append(link);
  });
  observer = new IntersectionObserver(entries => {
    const entry = entries.find(item => item.isIntersecting);
    if (!entry) return;
    for (const link of $('toc').children) link.classList.toggle('active', link.hash === '#' + entry.target.id);
  }, { rootMargin: '-180px 0px -55% 0px' });
  headings.forEach(heading => observer.observe(heading));
}
function mode(value) {
  editing = value;
  $('body').contentEditable = String(value);
  $('toolbar').hidden = !value;
  $('read').setAttribute('aria-pressed', String(!value));
  $('edit').setAttribute('aria-pressed', String(value));
}
function draw(note) {
  current = note;
  $('title').textContent = note.title;
  $('date').textContent = note.date || '';
  $('source').href = `https://notebrick.cn/app/#/edit/${note.sourceId}/detailed`;
  $('body').innerHTML = clean(note.html);
  prepareMath($('body'));
  outline();
  for (const link of $('lessons').querySelectorAll('a')) {
    if (link.dataset.id === note.id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${note.title} | 自动控制原理笔记`;
  mode(editing);
}
async function github(path, options = {}) {
  const response = await fetch(apiRoot + path, {
    ...options, cache: 'no-store', headers: { Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!response.ok) {
    if (response.status === 401) { token = ''; $('connect').textContent = '重新连接 GitHub'; }
    const message = await response.json().catch(() => ({}));
    throw new Error(`GitHub ${response.status}，${message.message || '请求失败'}`);
  }
  return response.json();
}
function decodeFile(file) {
  return normalize(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), character => character.charCodeAt(0)))));
}
function encodeFile(note) {
  const bytes = new TextEncoder().encode(JSON.stringify(note, null, 2) + '\n');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
const notePath = id => `static/notes/automatic-control/data/${id}.json`;
async function load(id) {
  if (busy) return;
  if (current) { clearTimeout(draftTimer); rememberDraft(); }
  const requestGeneration = ++generation;
  status('正在加载笔记');
  $('save').disabled = true;
  try {
    const response = await fetch(`./data/${id}.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error('笔记加载失败，请刷新重试');
    let note = normalize(await response.json());
    if (token) note = decodeFile(await github(`/contents/${notePath(id)}?ref=${branch}`));
    if (requestGeneration !== generation) return;
    baseline = structuredClone(note);
    let draft;
    try { draft = JSON.parse(localStorage.getItem(storagePrefix + id) || 'null'); } catch {}
    if (draft?.note) {
      if (same(draft.note, note)) localStorage.removeItem(storagePrefix + id);
      else { note = draft.note; baseline = draft.base || baseline; }
    }
    draw(note); rememberDraft();
  } catch (error) { status(error.message); }
}
async function save() {
  if (!current || busy) return;
  if (!token) { $('auth').showModal(); return; }
  clearTimeout(draftTimer);
  rememberDraft();
  const saving = content();
  const base = structuredClone(baseline);
  const id = current.id;
  busy = true; $('save').disabled = true; status('正在保存到 GitHub');
  try {
    const file = await github(`/contents/${notePath(id)}?ref=${branch}`);
    const remote = decodeFile(file);
    if (!same(remote, base) && !same(remote, saving)) {
      throw new Error('另一设备已修改此讲，草稿已保留。请先导出备份，再重新加载远程内容进行合并。');
    }
    if (!same(remote, saving)) {
      saving.updatedAt = new Date().toISOString();
      await github(`/contents/${notePath(id)}`, { method: 'PUT', body: JSON.stringify({
        message: `Update automatic control note: ${saving.title}`, content: encodeFile(saving), sha: file.sha, branch,
      }) });
    }
    baseline = saving;
    rememberDraft();
    status(changed ? '此版本已提交，新修改仍保留为草稿' : '已保存到 GitHub，网站正在自动发布');
  } catch (error) { status(error.message); }
  finally {
    busy = false; $('save').disabled = !changed;
    const requestedLesson = selectedLesson();
    if (requestedLesson && requestedLesson !== current.id) load(requestedLesson);
  }
}
function listLessons(query = '') {
  $('lessons').replaceChildren();
  for (const lesson of lessons) {
    if (query && !lesson.title.toLowerCase().includes(query.toLowerCase())) continue;
    const link = document.createElement('a'); link.href = '#lesson=' + lesson.id;
    link.dataset.id = lesson.id; link.textContent = lesson.title;
    if (current?.id === lesson.id) link.setAttribute('aria-current', 'page');
    $('lessons').append(link);
  }
  if (!$('lessons').children.length) $('lessons').textContent = '没有找到匹配的笔记';
}
function selectedLesson() {
  const id = new URLSearchParams(location.hash.slice(1)).get('lesson');
  return lessons.some(lesson => lesson.id === id) ? id : lessons[0]?.id;
}
function formulaDialog(element = null) {
  if (!editing) return;
  formulaTarget = element;
  insertionRange = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).cloneRange() : null;
  $('latex').value = element?.dataset.latex || '';
  $('display-math').checked = element?.dataset.display === 'true';
  previewMath(); $('math-dialog').showModal();
}
function previewMath() {
  katex.render(displayLatex($('latex').value || '\\text{公式预览}'), $('math-preview'), {
    throwOnError: false, trust: false, displayMode: $('display-math').checked,
  });
}
$('math-dialog').addEventListener('close', () => {
  if ($('math-dialog').returnValue !== 'apply' || !$('latex').value.trim()) return;
  const element = formulaTarget || document.createElement('span');
  element.className = 'math'; element.dataset.latex = $('latex').value;
  element.dataset.display = String($('display-math').checked);
  if (!formulaTarget) {
    if (insertionRange && $('body').contains(insertionRange.commonAncestorContainer)) insertionRange.insertNode(element);
    else $('body').append(element);
  }
  prepareMath($('body')); onInput();
});
$('body').addEventListener('dblclick', event => { const formula = event.target.closest('.math'); if (formula) formulaDialog(formula); });
$('body').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches('.math')) { event.preventDefault(); formulaDialog(event.target); }
});
$('body').addEventListener('paste', event => {
  if (!editing) return;
  const html = event.clipboardData.getData('text/html');
  if (html) { event.preventDefault(); document.execCommand('insertHTML', false, clean(html)); onInput(); }
});
$('body').addEventListener('input', onInput);
$('read').onclick = () => mode(false); $('edit').onclick = () => mode(true);
$('save').onclick = save;
$('connect').onclick = () => { if (token) { token = ''; $('connect').textContent = '连接 GitHub'; status('已断开 GitHub，草稿继续保存在浏览器'); } else $('auth').showModal(); };
$('authorize').onclick = async () => {
  const candidate = $('token').value.trim(); if (!candidate) return;
  $('authorize').disabled = true; $('auth-error').textContent = '';
  token = candidate; $('token').value = '';
  try {
    const repo = await github('');
    if (!repo.permissions?.push) throw new Error('此账号没有网站仓库的写入权限');
    $('connect').textContent = '断开 GitHub'; $('auth').close(); status('GitHub 已连接');
    await load(current.id);
  } catch (error) { token = ''; $('auth-error').textContent = error.message; }
  finally { $('authorize').disabled = false; }
};
$('auth').addEventListener('close', () => { $('token').value = ''; });
$('formula').onclick = () => formulaDialog(); $('latex').oninput = previewMath; $('display-math').onchange = previewMath;
for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('mousedown', event => event.preventDefault());
  button.onclick = () => { $('body').focus(); document.execCommand(button.dataset.command); onInput(); };
}
$('block').onchange = event => { $('body').focus(); document.execCommand('formatBlock', false, event.target.value); onInput(); };
$('export').onclick = () => {
  if (!current) return;
  rememberDraft(); const blob = new Blob([JSON.stringify(content(), null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = current.title + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('import').onclick = () => $('import-file').click();
$('import-file').onchange = async event => {
  const file = event.target.files[0];
  if (!file || !current || busy) return;
  try {
    const imported = JSON.parse(await file.text());
    if (imported.id !== current.id || typeof imported.html !== 'string') throw new Error('请先切换到备份对应的那一讲');
    if (changed) throw new Error('当前讲还有草稿，请先保存到 GitHub 或导出备份');
    draw({ ...current, html: clean(imported.html) }); mode(true); rememberDraft();
  } catch (error) { status(error.message); }
  finally { event.target.value = ''; }
};
$('search').oninput = event => listLessons(event.target.value);
function setCoursesCollapsed(collapsed) {
  document.querySelector('.workspace').classList.toggle('courses-collapsed', collapsed);
  $('courses-panel').hidden = collapsed;
  const label = collapsed ? '展开课程栏' : '收起课程栏';
  $('toggle-courses').setAttribute('aria-expanded', String(!collapsed));
  $('toggle-courses').setAttribute('aria-label', label);
  $('toggle-courses').title = label;
}
try { setCoursesCollapsed(localStorage.getItem('automatic-control-courses-collapsed') === 'true'); } catch { setCoursesCollapsed(false); }
$('toggle-courses').onclick = () => {
  const collapsed = $('toggle-courses').getAttribute('aria-expanded') === 'true';
  setCoursesCollapsed(collapsed);
  try { localStorage.setItem('automatic-control-courses-collapsed', String(collapsed)); } catch {}
};
window.addEventListener('hashchange', () => { const id = selectedLesson(); if (id && id !== current?.id) load(id); });
window.addEventListener('beforeunload', event => { if (changed) { rememberDraft(); event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
});
async function start() {
  try {
    const response = await fetch('./data/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('课程目录加载失败');
    lessons = await response.json(); listLessons(); await load(selectedLesson());
  } catch (error) { status(error.message); }
}
start();
