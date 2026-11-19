export function setupSidebarResize({ workspace, storageKey }) {
  const courses = workspace.querySelector('.courses');
  const outline = workspace.querySelector('.outline');
  const separator = document.createElement('div');
  separator.className = 'courses-resizer';
  separator.setAttribute('role', 'separator');
  separator.setAttribute('aria-label', '课程笔记栏宽度');
  separator.setAttribute('aria-orientation', 'vertical');
  separator.setAttribute('aria-controls', 'courses-panel');
  separator.title = '拖动调整宽度，双击恢复默认；方向键微调';
  workspace.insertBefore(separator, workspace.querySelector('main'));

  let preferred = null;
  let drag = null;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= 180) preferred = saved;
  } catch {}

  function limits() {
    const total = workspace.getBoundingClientRect().width || window.innerWidth;
    const outlineWidth = outline?.getBoundingClientRect().width || 0;
    return { min: 180, max: Math.max(180, Math.min(560, total - outlineWidth - 360)) };
  }
  function clamp(value) {
    const { min, max } = limits();
    return Math.round(Math.max(min, Math.min(max, value)));
  }
  function remember() {
    try {
      if (preferred === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferred));
    } catch {}
  }
  function refresh() {
    if (preferred === null) workspace.style.removeProperty('--courses-custom-width');
    else workspace.style.setProperty('--courses-custom-width', clamp(preferred) + 'px');
    const hidden = workspace.classList.contains('courses-collapsed') || window.innerWidth <= 720;
    separator.hidden = hidden;
    separator.tabIndex = hidden ? -1 : 0;
    const { min, max } = limits();
    const width = clamp(preferred ?? (courses.getBoundingClientRect().width || 268));
    separator.setAttribute('aria-valuemin', String(min));
    separator.setAttribute('aria-valuemax', String(max));
    separator.setAttribute('aria-valuenow', String(width));
    separator.setAttribute('aria-valuetext', width + ' 像素');
  }
  function finish(event) {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.id)) return;
    const id = drag.id;
    drag = null;
    document.body.classList.remove('resizing-courses');
    if (separator.hasPointerCapture?.(id)) separator.releasePointerCapture(id);
    remember();
  }
  function reset() {
    finish();
    preferred = null;
    refresh();
    remember();
  }
  separator.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || separator.hidden) return;
    event.preventDefault();
    separator.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX,
      width: courses.getBoundingClientRect().width || Number(separator.getAttribute('aria-valuenow')),
      previous: preferred };
    separator.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-courses');
  });
  separator.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    preferred = clamp(drag.width + event.clientX - drag.x);
    refresh();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    separator.addEventListener(type, finish);
  }
  separator.addEventListener('dblclick', reset);
  separator.addEventListener('keydown', event => {
    if (separator.hidden) return;
    if (event.key === 'Escape' && drag) {
      preferred = drag.previous;
      finish();
      refresh();
    } else if (event.key === 'Enter') reset();
    else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const { min, max } = limits();
      const current = courses.getBoundingClientRect().width || Number(separator.getAttribute('aria-valuenow'));
      preferred = event.key === 'Home' ? min : event.key === 'End' ? max
        : clamp(current + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 50 : 10));
      refresh();
      remember();
    } else return;
    event.preventDefault();
  });
  window.addEventListener('blur', () => finish());
  window.addEventListener('resize', () => { finish(); refresh(); });
  refresh();
  return { refresh: () => { finish(); refresh(); } };
}
