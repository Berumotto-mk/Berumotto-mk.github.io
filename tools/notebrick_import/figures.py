import json
import hashlib
import os
import re
from pathlib import Path
import pymupdf as fitz


def extract_figures(source_root, jobs):
    ROOT = Path(source_root)
    IMAGE_DIR = ROOT / 'images'
    IMAGE_DIR.mkdir(exist_ok=True)
    manifest = jobs
    algorithm = hashlib.sha256(Path(__file__).read_bytes()).digest()
    asset_map = json.loads((ROOT / 'asset-map.json').read_text(encoding='utf-8')) if (ROOT / 'asset-map.json').exists() else {}
    review = json.loads((ROOT / 'figure-review.json').read_text(encoding='utf-8')) if (ROOT / 'figure-review.json').exists() else []
    cache = json.loads((ROOT / 'figure-cache.json').read_text(encoding='utf-8')) if (ROOT / 'figure-cache.json').exists() else {}

    def checkpoint():
        for name, value in [('asset-map.json', asset_map), ('figure-review.json', review), ('figure-cache.json', cache)]:
            temporary = ROOT / (name + '.tmp')
            temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(temporary, ROOT / name)


    def crop_svg(pdf, page_index, rectangle, name):
        rectangle &= pdf[page_index].rect
        if rectangle.width < 10 or rectangle.height < 5:
            raise ValueError('Invalid figure bounds ' + name)
        pdf[page_index].get_pixmap(matrix=fitz.Matrix(3.5, 3.5), clip=rectangle, alpha=False).save(IMAGE_DIR / name)


    def text_fragments(node):
        if isinstance(node, dict):
            if node.get('t') == 'text':
                yield node.get('v', '')
            else:
                for value in node.values():
                    yield from text_fragments(value)
        elif isinstance(node, list):
            for value in node:
                yield from text_fragments(value)


    def anchor(page, node, rectangle, tail=False):
        fragments = list(text_fragments(node))
        if tail:
            fragments.reverse()
        for text in fragments:
            text = re.sub(r'\s+', ' ', text).strip()
            if len(text) < 5:
                continue
            term = text[-18:] if tail else text[:18]
            matches = [box for box in page.search_for(term) if rectangle.intersects(box)]
            if matches:
                return max(box.y1 for box in matches) if tail else min(box.y0 for box in matches)
        return None


    def trim_caption(page, rectangle, node):
        matches = []
        for image in node.get('images', []):
            for fragment in text_fragments(image.get('caption', [])):
                term = fragment.strip()[:18]
                if len(term) < 2:
                    continue
                matches.extend(box.y0 for box in page.search_for(term) if rectangle.contains(box))
        if matches and min(matches) > rectangle.y0 + 10:
            rectangle.y1 = min(rectangle.y1, min(matches) - 2)
        return rectangle


    def graphic_rectangle(page, rectangle):
        candidates = [fitz.Rect(image['bbox']) & rectangle for image in page.get_image_info() if rectangle.intersects(fitz.Rect(image['bbox']))]
        for drawing in page.get_drawings():
            bounds = drawing['rect']
            if not rectangle.contains(bounds) or (bounds.width <= 0 and bounds.height <= 0):
                continue
            bounds = fitz.Rect(bounds)
            if bounds.width <= 0:
                bounds.x0 -= .4
                bounds.x1 += .4
            if bounds.height <= 0:
                bounds.y0 -= .4
                bounds.y1 += .4
            if bounds.width >= rectangle.width * .94 and bounds.height >= rectangle.height * .6:
                continue
            candidates.append(bounds)
        if not candidates:
            return None
        result = fitz.Rect(candidates[0])
        for candidate in candidates[1:]:
            result |= candidate
        return fitz.Rect(result.x0-3, result.y0-3, result.x1+3, result.y1+3) & rectangle


    def find_anchor(pdf, ranges, body, tail=False):
        fragments = list(text_fragments(body))
        if tail:
            fragments.reverse()
        for text in fragments:
            text = re.sub(r'\s+', ' ', text).strip()
            if len(text) < 5:
                continue
            term = text[-18:] if tail else text[:18]
            matches = []
            for page_index, rectangle in ranges:
                matches.extend((page_index, box) for box in pdf[page_index].search_for(term) if rectangle.intersects(box))
            if matches:
                return max(matches, key=lambda item: (item[0], item[1].y1)) if tail else min(matches, key=lambda item: (item[0], item[1].y0))
        return None


    def linear_nodes(value):
        if isinstance(value, list):
            for child in value:
                yield from linear_nodes(child)
        elif isinstance(value, dict):
            if value.get('t') in ('fig', 'text', 'math'):
                yield value
            else:
                for child in value.values():
                    if isinstance(child, (dict, list)):
                        yield from linear_nodes(child)


    def walk_nodes(value):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from walk_nodes(child)
        elif isinstance(value, list):
            for child in value:
                yield from walk_nodes(child)


    for job in manifest:
        job_id = job['id']
        source = json.loads((ROOT / (job_id + '.json')).read_text(encoding='utf-8'))
        if not any(node.get('t') == 'fig' or node.get('kind') == 'fig' for node in walk_nodes(source['blocks'])):
            continue
        places = json.loads((ROOT / (job_id + '-places.json')).read_text(encoding='utf-8'))['places']
        pdf_file = ROOT / 'pdf' / (job_id + '.pdf')
        stamp = hashlib.sha256(algorithm + (ROOT / (job_id + '.json')).read_bytes() +
            (ROOT / (job_id + '-places.json')).read_bytes() +
            str((pdf_file.stat().st_size, pdf_file.stat().st_mtime_ns)).encode()).hexdigest()
        expected = sum(b['kind'] == 'fig' for b in source['blocks']) + sum(
            n.get('t') == 'fig' for b in source['blocks'] for n in walk_nodes(b['read']))
        keys = [key for key in asset_map if key.startswith(job_id + '/')]
        if cache.get(job_id) == stamp and len(keys) == expected and all((IMAGE_DIR / asset_map[key]).is_file() for key in keys):
            print('Cached figures:', job_id, expected, flush=True)
            continue
        for key in keys:
            del asset_map[key]
        review[:] = [item for item in review if item['job'] != job_id]
        left_margin = min(place['x'] for place in places if place['x'] > 0)
        content_top = min([left_margin + 22.68] + [place['y'] for place in places if place['page'] > 1 and place['y'] > 0])
        positions = {place['id']: (index, place) for index, place in enumerate(places)}
        pdf = fitz.open(ROOT / 'pdf' / (job_id + '.pdf'))
        count = 0
        for block in source['blocks']:
            body = list(linear_nodes(block['read'].get('body', [])))
            nested = [(index, node) for index, node in enumerate(body) if node.get('t') == 'fig']
            if block['kind'] != 'fig' and not nested:
                continue
            index, position = positions[block['id']]
            page_index = position['page'] - 1
            following = places[index + 1] if index + 1 < len(places) else None
            bottom = following['y'] - 8 if following and following['page'] == position['page'] else pdf[page_index].rect.height - left_margin
            bounds = fitz.Rect(position['x'], position['y'], pdf[page_index].rect.width - left_margin, bottom)
            if block['kind'] == 'fig':
                filename = f'{job_id}-{block["id"]}.png'
                bounds = trim_caption(pdf[page_index], bounds, block['read'])
                crop_svg(pdf, page_index, bounds, filename)
                asset_map[job_id + '/' + block['id']] = filename
                count += 1
                continue
            for number, (body_index, node) in enumerate(nested):
                last_page = following['page'] - 1 if following else len(pdf) - 1
                ranges = []
                for candidate_page in range(page_index, last_page + 1):
                    top = position['y'] if candidate_page == page_index else content_top
                    bottom = following['y'] - 1 if following and candidate_page == last_page else pdf[candidate_page].rect.height - left_margin
                    if bottom > top:
                        ranges.append((candidate_page, fitz.Rect(position['x'], top, pdf[candidate_page].rect.width - left_margin, bottom)))
                start = find_anchor(pdf, ranges, body[:body_index], tail=True)
                end = find_anchor(pdf, ranges, body[body_index + 1:])
                candidates = []
                for candidate_page, rectangle in ranges:
                    rectangle = fitz.Rect(rectangle)
                    if start:
                        if candidate_page < start[0]:
                            continue
                        if candidate_page == start[0]:
                            rectangle.y0 = max(rectangle.y0, start[1].y1 + 3)
                    if end:
                        if candidate_page > end[0]:
                            continue
                        if candidate_page == end[0]:
                            rectangle.y1 = min(rectangle.y1, end[1].y0 - 3)
                    graphics = graphic_rectangle(pdf[candidate_page], rectangle)
                    if graphics and graphics.height > 10:
                        candidates.append((candidate_page, graphics))
                if not candidates:
                    for candidate_page, rectangle in ranges:
                        graphics = graphic_rectangle(pdf[candidate_page], rectangle)
                        if graphics:
                            candidates.append((candidate_page, graphics))
                if not candidates:
                    raise ValueError('Missing diagram ' + block['id'])
                figure_page, figure_bounds = max(candidates, key=lambda item: item[1].width * item[1].height)
                filename = f'{job_id}-{block["id"]}-figure-{number}.png'
                review.append({'job': job_id, 'block': block['id'], 'bodyIndex': body_index, 'page': figure_page + 1, 'crop': list(figure_bounds)})
                figure_bounds = trim_caption(pdf[figure_page], figure_bounds, node)
                crop_svg(pdf, figure_page, figure_bounds, filename)
                asset_map[f'{job_id}/{block["id"]}/figure-{number}'] = filename
                count += 1
        print('Figures extracted:', job_id, count, flush=True)
        pdf.close()
        cache[job_id] = stamp
        checkpoint()
    checkpoint()
    print('Total figure blocks:', len(asset_map), 'Need visual review:', len(review))

    return asset_map
