// Number structural headings only; NoteBrick groups and callout labels are unnumbered.
export function numberHeadings(root) {
  clearHeadingNumbers(root);
  const headings = [...root.querySelectorAll('h2,h3,h4')].filter(
    heading => !heading.closest('section.callout') && heading.dataset.kind !== 'group',
  );
  const counters = [0, 0, 0];
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1)) - 2;
    for (let parent = 0; parent < level; parent++) {
      if (!counters[parent]) counters[parent] = 1;
    }
    counters[level]++;
    counters.fill(0, level + 1);
    heading.dataset.headingNumber = counters.slice(0, level + 1).join('.');
  }
  return headings;
}

// Generated numbers are presentation, never authored note content or saved drafts.
export function clearHeadingNumbers(root) {
  for (const heading of root.querySelectorAll('[data-heading-number]')) {
    heading.removeAttribute('data-heading-number');
  }
}
