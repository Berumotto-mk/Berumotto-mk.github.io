import html
import json
import re
from pathlib import Path


def render_note(source, job, note_id, asset_map):
    escape = lambda value: html.escape(str(value or ''), quote=True)
    unknown = set()
    current_job = job['id']
    current_block = None
    figure_index = 0


    def picture(nested=False, node=None):
        nonlocal figure_index
        key = current_job + '/' + current_block['id']
        if nested:
            key += '/figure-' + str(figure_index)
            figure_index += 1
        filename = asset_map.get(key)
        if not filename:
            raise ValueError('Missing migrated figure ' + key)
        filename = Path(filename).with_suffix('.webp').name
        node = node or current_block['read']
        captions = [render_many(image.get('caption')) for image in node.get('images', []) if image.get('caption')]
        caption = '<figcaption>' + ' · '.join(captions) + '</figcaption>' if captions else ''
        return '<figure><img src="./images/' + escape(filename) + '" alt="课程图示" loading="lazy">' + caption + '</figure>'


    def render_many(items, display=False):
        return ''.join(render(item, display) for item in (items or []))


    def render(item, display=False):
        if isinstance(item, list):
            return render_many(item, display)
        if isinstance(item, str):
            return escape(item)
        if not isinstance(item, dict):
            return ''
        kind = item.get('t') or item.get('kind')
        if kind == 'text':
            text = escape(item.get('v', ''))
            for flag, tag in [('code', 'code'), ('em', 'em'), ('i', 'em'), ('str', 'strong'), ('b', 'strong')]:
                if item.get(flag):
                    text = f'<{tag}>{text}</{tag}>'
            if item.get('href'):
                text = '<a href="' + escape(item['href']) + '">' + text + '</a>'
            return text
        if kind == 'math':
            latex = item.get('latex', '')
            display = display or '\\tag{' in latex
            return '<span class="math" data-latex="' + escape(latex) + '" data-display="' + str(display).lower() + '" contenteditable="false">' + escape(latex) + '</span>'
        if kind == 'p':
            return '<p>' + render_many(item.get('c')) + '</p>'
        if kind in ('table', 'key-table'):
            headers = item.get('headers') or []
            head = '<thead><tr>' + ''.join('<th>' + render_many(cell) + '</th>' for cell in headers) + '</tr></thead>' if headers else ''
            rows = ''.join('<tr>' + ''.join('<td>' + render_many(cell) + '</td>' for cell in row) + '</tr>' for row in item.get('rows', []))
            return '<table>' + head + '<tbody>' + rows + '</tbody></table>'
        if kind == 'list':
            tag = 'ol' if item.get('ordered') else 'ul'
            return f'<{tag}>' + ''.join('<li>' + render_many(child, True) + '</li>' for child in item.get('items', [])) + f'</{tag}>'
        if kind == 'code':
            return '<pre><code>' + escape(item.get('text', '')) + '</code></pre>'
        if kind in ('nl', 'br'):
            return '<br>'
        if kind == 'flow':
            steps = item.get('steps', [])
            via = item.get('via') or []
            parts = []
            for index, step in enumerate(steps):
                parts.append('<div>' + render_many(step) + '</div>')
                if index < len(steps) - 1:
                    parts.append('<span class="flow-via">→ ' + (render_many(via[index]) if index < len(via) else '') + '</span>')
            return '<div class="flow">' + ''.join(parts) + '</div>'
        if kind == 'call':
            return '<div class="flow">' + ''.join('<div>' + render_many(hole.get('body'), True) + '</div>' for hole in item.get('holes', [])) + '</div>'
        if kind == 'box':
            title = render_many(item.get('title'))
            return '<section class="callout" data-kind="' + escape(item.get('kind', 'note')) + '">' + ('<h4>' + title + '</h4>' if title else '') + render_many(item.get('body'), True) + '</section>'
        if kind == 'fig':
            return picture(nested=True, node=item)
        if kind == 'raw':
            if item.get('src') == '#set':
                return ''
            raw_text = re.fullmatch(r'#raw\(("(?:[^"\\]|\\.)*")\)', item.get('src', ''))
            if raw_text:
                return '<code>' + escape(json.loads(raw_text.group(1))) + '</code>'
            return '<pre><code>' + escape(item.get('src', '')) + '</code></pre>'
        unknown.add(kind)
        return '<pre><code>' + escape(json.dumps(item, ensure_ascii=False)) + '</code></pre>'


    def block_html(block):
        nonlocal current_block, figure_index
        current_block = block
        figure_index = 0
        read = block['read']
        kind = block['kind']
        title = render_many(read.get('title'))
        if kind in ('section', 'subsection', 'group'):
            tag = {'section': 'h2', 'subsection': 'h3', 'group': 'h4'}[kind]
            attribute = ' data-kind="group"' if kind == 'group' else ''
            body = f'<{tag}{attribute}>{title}</{tag}>'
        elif kind == 'fig':
            body = picture()
        elif kind == 'key-table':
            body = render(read)
        elif kind == 'pagebreak':
            body = '<hr>'
        else:
            body = render_many(read.get('body'), True)
            if kind not in ('paragraph', 'text'):
                body = '<section class="callout" data-kind="' + escape(kind) + '">' + ('<h4>' + title + '</h4>' if title else '') + body + '</section>'
        return '<div data-block="' + escape(block['id']) + '">' + body + '</div>'


    body = '\n'.join(block_html(block) for block in source['blocks'])
    if unknown:
        raise ValueError('Unsupported NoteBrick content types: ' + repr(unknown))
    date = source.get('date') or {}
    date = date.get('text', '') if isinstance(date, dict) else str(date)
    return {'id': note_id, 'sourceId': job['id'], 'title': source['title'],
            'date': date or job.get('recordingDate', ''),
            'recordingDate': job.get('recordingDate', ''), 'html': body}
