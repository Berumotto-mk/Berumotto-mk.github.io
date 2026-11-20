const HIGHLIGHTS = { yellow: ['黄色', '#fff1a8'], green: ['绿色', '#caf5d9'], pink: ['粉色', '#ffd8e7'], blue: ['蓝色', '#d5eaff'], purple: ['紫色', '#e9ddff'], orange: ['橙色', '#ffe0b5'] };
const COLORS = { red: ['红色', '#c62828'], blue: ['蓝色', '#155eef'], green: ['绿色', '#087443'], purple: ['紫色', '#7c3aed'], gray: ['灰色', '#64748b'], black: ['黑色', '#172b38'] };
const PROPERTIES = ['highlight', 'color', 'bold', 'italic', 'underline', 'size'];

export function setupAnnotations({ root, editToolbar, snapshot, restore, onChange, status, canApply }) {
  const doc = root.ownerDocument;
  const readBar = doc.createElement('div');
  readBar.className = 'annotation-bar';
  readBar.setAttribute('role', 'toolbar');
  readBar.setAttribute('aria-label', '阅读标注');
  editToolbar.before(readBar);
  const floating = doc.createElement('div');
  floating.className = 'annotation-floating';
  floating.setAttribute('role', 'toolbar');
  floating.setAttribute('aria-label', '选中文字标注工具');
  floating.hidden = true;
  doc.body.append(floating);
  const palette = doc.createElement('div');
  palette.className = 'annotation-palette';
  palette.setAttribute('role', 'group');
  palette.hidden = true;
  doc.body.append(palette);
  const editGroup = doc.createElement('span');
  editGroup.className = 'annotation-edit-group';
  editToolbar.append(editGroup);
  const controls = [readBar, editGroup, floating, palette];
  let savedRange = null;
  let pinned = false;
  let changing = false;
  let selecting = false;
  let editing = false;
  let noteId;
  let undo = [];
  let redo = [];
  const buttons = [];
  const historyButtons = [];

  function button(parent, label, text, action, history = '') {
    const element = doc.createElement('button');
    element.type = 'button'; element.title = label;
    element.setAttribute('aria-label', label); element.textContent = text;
    element.addEventListener('mousedown', event => event.preventDefault());
    element.addEventListener('click', action);
    parent.append(element);
    if (history) historyButtons.push({ element, history }); else buttons.push(element);
    return element;
  }
  function place(element, rect, above = false) {
    const width = element.offsetWidth || 440;
    const height = element.offsetHeight || 44;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = above ? rect.top - height - 9 : rect.bottom + 8;
    if (top < 82) top = rect.bottom + 9;
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    element.style.left = left + 'px'; element.style.top = top + 'px';
  }
  function position() {
    if (floating.hidden || !savedRange?.startContainer.isConnected) return;
    const rect = savedRange.getBoundingClientRect();
    if (rect.bottom < 82 || rect.top > window.innerHeight) { floating.hidden = true; palette.hidden = true; return; }
    place(floating, rect, true);
  }
  function scrollMargin() {
    const bar = editing ? editToolbar : readBar;
    const top = Number.parseFloat(getComputedStyle(bar).top) || 140;
    root.style.setProperty('--note-scroll-margin', Math.ceil(top + bar.getBoundingClientRect().height + 24) + 'px');
  }
  function update() {
    const active = Boolean(savedRange && root.contains(savedRange.commonAncestorContainer) && canApply());
    for (const element of buttons) element.disabled = !active;
    for (const { element, history } of historyButtons) element.disabled = !(history === 'undo' ? undo.length : redo.length);
  }
  function state(node) {
    const result = {};
    for (let element = node.nodeType === 1 ? node : node.parentElement; element && element !== root; element = element.parentElement) {
      if (!element.classList.contains('note-annotation')) continue;
      for (const property of PROPERTIES) {
        const value = element.getAttribute('data-note-' + property);
        if (value !== null && result[property] === undefined) result[property] = value;
      }
    }
    return result;
  }
  function units() {
    const result = [];
    function visit(node) {
      if (node.nodeType === 3) { if (node.length) result.push(node); return; }
      if (node.nodeType !== 1) return;
      if (node.classList.contains('math')) { result.push(node); return; }
      if (node !== root && node.getAttribute('contenteditable') === 'false') return;
      for (const child of node.childNodes) visit(child);
    }
    visit(root);
    return result;
  }
  function apply(property, value) {
    if (!savedRange || !canApply() || !root.contains(savedRange.commonAncestorContainer)) return;
    const range = savedRange.cloneRange();
    const records = units().map(node => ({ node, attributes: state(node), selected: range.intersectsNode(node),
      start: node === range.startContainer ? range.startOffset : 0,
      end: node === range.endContainer ? range.endOffset : node.nodeType === 3 ? node.length : 0 }));
    const selected = records.filter(item => item.selected && (item.node.nodeType !== 3 || item.end > item.start));
    if (!selected.length) return;
    const before = snapshot();
    if (['bold', 'italic', 'underline'].includes(property)) {
      value = selected.every(item => item.attributes[property] === 'true') ? null : 'true';
    }
    changing = true;
    // Canonicalize only our wrappers, retaining authored strong/em, tables and block structure.
    for (const wrapper of [...root.querySelectorAll('span.note-annotation:not(.math)')]) wrapper.replaceWith(...wrapper.childNodes);
    const selectionNodes = [];
    function decorate(node, attributes) {
      if (!Object.keys(attributes).length) return;
      if (node.nodeType === 1) {
        node.classList.add('note-annotation');
        for (const [key, val] of Object.entries(attributes)) node.setAttribute('data-note-' + key, val);
      } else {
        const span = doc.createElement('span'); span.className = 'note-annotation';
        for (const [key, val] of Object.entries(attributes)) span.setAttribute('data-note-' + key, val);
        node.replaceWith(span); span.append(node);
      }
    }
    for (const item of records) {
      const { node, attributes } = item;
      if (node.nodeType === 1) {
        node.classList.remove('note-annotation');
        for (const key of PROPERTIES) node.removeAttribute('data-note-' + key);
      }
      if (!selected.includes(item)) { decorate(node, attributes); continue; }
      let target = node;
      if (node.nodeType === 3) {
        if (item.end < node.length) decorate(node.splitText(item.end), attributes);
        if (item.start > 0) { target = node.splitText(item.start); decorate(node, attributes); }
      }
      const next = property === 'clear' ? {} : { ...attributes };
      if (property !== 'clear') { if (value === null) delete next[property]; else next[property] = value; }
      decorate(target, next);
      selectionNodes.push(target);
    }
    const nextRange = doc.createRange();
    const first = selectionNodes[0], last = selectionNodes.at(-1);
    if (first.nodeType === 3) nextRange.setStart(first, 0); else nextRange.setStartBefore(first);
    if (last.nodeType === 3) nextRange.setEnd(last, last.length); else nextRange.setEndAfter(last);
    savedRange = nextRange; pinned = true;
    window.getSelection()?.removeAllRanges();
    const after = snapshot();
    if (before.html !== after.html) {
      undo.push({ before, after }); if (undo.length > 30) undo.shift(); redo = [];
      onChange();
    }
    changing = false;
    floating.hidden = false; position(); update();
  }
  function history(direction) {
    const from = direction === 'undo' ? undo : redo;
    const to = direction === 'undo' ? redo : undo;
    const entry = from.at(-1);
    if (!entry || !canApply()) return;
    const expected = direction === 'undo' ? entry.after : entry.before;
    const now = snapshot();
    if (now.html !== expected.html) { status('正文已继续编辑，可选中文字清除标注，或使用编辑工具栏撤销正文修改'); return; }
    from.pop(); to.push(entry);
    restore({ ...now, html: (direction === 'undo' ? entry.before : entry.after).html });
    onChange(); update();
  }
  function openPalette(property, anchor) {
    const options = property === 'highlight' ? HIGHLIGHTS : COLORS;
    palette.replaceChildren(); palette.setAttribute('aria-label', property === 'highlight' ? '荧光笔颜色' : '文字颜色');
    for (const [value, [name, color]] of Object.entries(options)) {
      const choice = doc.createElement('button'); choice.type = 'button'; choice.className = 'annotation-swatch';
      choice.style.backgroundColor = color; choice.title = name;
      choice.setAttribute('aria-label', (property === 'highlight' ? '荧光笔：' : '字色：') + name);
      choice.addEventListener('mousedown', event => event.preventDefault());
      choice.onclick = () => { apply(property, value); palette.hidden = true; };
      palette.append(choice);
    }
    const clear = doc.createElement('button'); clear.type = 'button'; clear.textContent = property === 'highlight' ? '无底色' : '默认字色';
    clear.addEventListener('mousedown', event => event.preventDefault());
    clear.onclick = () => { apply(property, null); palette.hidden = true; };
    palette.append(clear); palette.hidden = false; place(palette, anchor.getBoundingClientRect());
  }
  for (const parent of [readBar, editGroup, floating]) {
    button(parent, '荧光笔颜色', '🖍 荧光笔', event => openPalette('highlight', event.currentTarget));
    button(parent, '文字颜色', 'A 字色', event => openPalette('color', event.currentTarget));
    if (parent === floating) {
      button(parent, '加粗标注', 'B', () => apply('bold', 'true')).classList.add('annotation-bold');
      button(parent, '斜体标注', 'I', () => apply('italic', 'true')).classList.add('annotation-italic');
      button(parent, '下划线标注', 'U', () => apply('underline', 'true')).classList.add('annotation-underline');
    }
    if (parent !== readBar) {
      const size = doc.createElement('select'); size.setAttribute('aria-label', '标注字号');
      for (const [value, label] of [['', '字号'], ['small', '较小'], ['normal', '默认'], ['large', '较大'], ['xlarge', '大字']]) {
        const option = doc.createElement('option'); option.value = value; option.textContent = label; size.append(option);
      }
      size.onchange = () => { if (size.value) apply('size', size.value === 'normal' ? null : size.value); size.value = ''; };
      parent.append(size); buttons.push(size);
    }
    button(parent, '清除选中的标注', '清除', () => apply('clear', null));
    button(parent, '撤销标注', '↶', () => history('undo'), 'undo');
    button(parent, '重做标注', '↷', () => history('redo'), 'redo');
  }
  doc.addEventListener('selectionchange', () => {
    if (changing) return;
    const selection = window.getSelection();
    if (selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (root.contains(range.startContainer) && root.contains(range.endContainer)) {
        savedRange = range.cloneRange(); pinned = false; floating.hidden = selecting; position(); update(); return;
      }
    }
    if (pinned || controls.some(element => element.contains(doc.activeElement))) return;
    savedRange = null; floating.hidden = true; update();
  });
  doc.addEventListener('pointerdown', event => {
    if (controls.some(element => element.contains(event.target))) return;
    pinned = false; palette.hidden = true;
    selecting = root.contains(event.target);
    savedRange = null; floating.hidden = true; update();
  });
  for (const type of ['pointerup', 'pointercancel']) doc.addEventListener(type, () => {
    if (!selecting) return;
    selecting = false;
    if (savedRange) { floating.hidden = false; position(); update(); }
  });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape') { floating.hidden = true; palette.hidden = true; pinned = false; }
    if (editing || event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
      const direction = event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo';
      if ((direction === 'undo' ? undo : redo).length) { event.preventDefault(); history(direction); }
    }
  });
  window.addEventListener('scroll', () => { palette.hidden = true; position(); }, true);
  window.addEventListener('resize', () => { palette.hidden = true; position(); scrollMargin(); });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(scrollMargin);
    observer.observe(readBar); observer.observe(editToolbar);
  }
  update();
  return {
    refresh: update,
    setMode(value) { editing = value; readBar.hidden = value; scrollMargin(); },
    reset(id) {
      if (noteId !== id) { undo = []; redo = []; noteId = id; }
      savedRange = null; pinned = false; floating.hidden = true; palette.hidden = true; update();
    },
  };
}
