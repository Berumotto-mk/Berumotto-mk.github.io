"""Run with python -m tools.notebrick_import. Raw exports stay outside the site repo."""
import argparse
import getpass
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup
from PIL import Image
from .render import render_note
from .figures import extract_figures


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest() if Path(path).is_file() else None


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def source(path):
    raw = Path(path).read_text(encoding='utf-8')
    if any(marker in raw for marker in ('[MaxDepth]', '[Truncated]')):
        raise ValueError(f'Truncated browser export: {path}. Export DOM text in chunks, not a deep object.')
    value = json.loads(raw)
    if not isinstance(value.get('blocks'), list) or not value['blocks'] or not value.get('title'):
        raise ValueError(f'Incomplete note source: {path}')
    if any(not isinstance(block.get('read'), dict) for block in value['blocks']):
        raise ValueError(f'Unreadable source blocks: {path}')
    identifiers = [block.get('id', '') for block in value['blocks']]
    if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', identifier) for identifier in identifiers):
        raise ValueError(f'Invalid source block IDs: {path}')
    # NoteBrick can repeat the same block ID for an identical copied paragraph.
    # Preserve both occurrences; only conflicting reuse is ambiguous for image mapping.
    seen = {}
    for block in value['blocks']:
        content = (block['kind'], block['read'])
        if block['id'] in seen and seen[block['id']] != content:
            raise ValueError(f'Conflicting source block IDs: {path}')
        seen[block['id']] = content
    return value


def figure_count(value):
    return sum(b['kind'] == 'fig' for b in value['blocks']) + sum(
        n.get('t') == 'fig' for b in value['blocks'] for n in walk(b['read']))


def validate_note(original, note, folder):
    soup = BeautifulSoup(note['html'], 'html.parser')
    nodes = [n for block in original['blocks'] for n in walk(block['read'])]
    latex = [n['latex'] for n in nodes if n.get('t') == 'math']
    if sorted(latex) != sorted(n['data-latex'] for n in soup.select('.math[data-latex]')):
        raise ValueError(f"Formula mismatch: {note['title']}")
    if len(soup.select('[data-block]')) != len(original['blocks']):
        raise ValueError(f"Block mismatch: {note['title']}")
    normalized = lambda text: re.sub(r'\s+', ' ', text).strip()
    plain = normalized(soup.get_text())
    for node in nodes:
        text = node.get('v', '') if node.get('t') == 'text' else node.get('text', '') if node.get('t') == 'code' else ''
        if len(normalized(text)) >= 2 and normalized(text) not in plain:
            raise ValueError(f"Missing source text in {note['title']}: {text[:60]}")
    images = soup.select('img')
    if len(images) != figure_count(original):
        raise ValueError(f"Figure mismatch: {note['title']}")
    for image in images:
        relative = Path(image['src'].removeprefix('./'))
        target = (folder / relative).resolve()
        if not target.is_relative_to(folder.resolve()) or not target.is_file():
            raise ValueError(f'Missing or invalid image: {relative}')
    return {'blocks': len(original['blocks']), 'formulas': len(latex), 'figures': len(images)}


def read_jobs(path):
    raw_jobs = read(path)
    if isinstance(raw_jobs, dict):
        raw_jobs = raw_jobs['jobs']
    jobs = []
    for item in raw_jobs:
        identifier = item.get('id') or item.get('url', '').split('/notes/')[-1].split('/edit/')[-1].split('/')[0]
        if not re.fullmatch(r'[a-f0-9]{24,64}', identifier):
            raise ValueError(f'Invalid NoteBrick job ID: {identifier}')
        date = item.get('recordingDate') or item.get('date') or ''
        if not date:
            match = re.search(r'\d{4}-\d{2}-\d{2}', item.get('title', ''))
            date = match.group() if match else ''
        jobs.append({'id': identifier, 'title': item.get('title', ''), 'recordingDate': date})
    if not jobs or len({j['id'] for j in jobs}) != len(jobs):
        raise ValueError('Choose at least one note and remove duplicate source IDs.')
    jobs.sort(key=lambda j: j['recordingDate'] or '9999')
    return jobs


def init(args):
    repo = Path(args.repo).resolve()
    work = Path(args.work).resolve()
    if work.is_relative_to(repo):
        raise ValueError('Keep the private export workspace outside the published Git repository.')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', args.slug):
        raise ValueError('Use a lowercase, hyphenated course slug, without path separators.')
    config_file = work / 'import.json'
    if config_file.exists():
        raise ValueError(f'Import already initialized: {config_file}. Resume it instead.')
    jobs = read_jobs(args.sources)
    repository = args.repository
    if not repository:
        remote = subprocess.check_output(['git', '-C', str(repo), 'remote', 'get-url', 'origin'], text=True).strip()
        match = re.search(r'github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$', remote)
        if not match:
            raise ValueError('Specify --repository owner/name for the GitHub save target.')
        repository = '/'.join(match.groups())
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid GitHub owner/repository.')
    raw = Path(args.source_dir).resolve() if args.source_dir else work / 'raw'
    raw.mkdir(parents=True, exist_ok=True)
    config = {'version': 1, 'repo': str(repo), 'work': str(work), 'source': str(raw),
              'slug': args.slug, 'title': args.title, 'repository': repository,
              'branch': args.branch, 'jobs': jobs}
    write(config_file, config)
    print(config_file)


def status(config):
    root = Path(config['source'])
    folder = Path(config['repo']) / 'static/notes' / config['slug']
    listing = read(folder / 'data/manifest.json') if (folder / 'data/manifest.json').exists() else []
    preserved = {read(folder / 'data' / (item['id'] + '.json'))['sourceId'] for item in listing}
    results = []
    for job in config['jobs']:
        if job['id'] in preserved:
            results.append({'id': job['id'], 'ready': True, 'preserved': True, 'missing': []})
            continue
        missing = []
        try:
            original = source(root / (job['id'] + '.json'))
            if figure_count(original):
                for relative in (job['id'] + '-places.json', 'pdf/' + job['id'] + '.pdf'):
                    if not (root / relative).is_file():
                        missing.append(relative)
                    elif relative.endswith('-places.json') and not read(root / relative).get('places'):
                        missing.append('Invalid or empty positions: ' + relative)
                    elif relative.endswith('.pdf'):
                        with (root / relative).open('rb') as pdf:
                            if pdf.read(4) != b'%PDF':
                                missing.append('Invalid PDF: ' + relative)
        except (OSError, ValueError) as error:
            missing.append(str(error))
        results.append({'id': job['id'], 'ready': not missing, 'missing': missing})
    print(json.dumps(results, ensure_ascii=False, indent=2))


def download(config, key):
    # Read-only API requests; no submission, re-generation or credential creation.
    if not key:
        raise ValueError('Supply an existing authorized key through stdin or NOTEBRICK_API_KEY.')
    root = Path(config['source'])
    for job in config['jobs']:
        target = root / 'pdf' / (job['id'] + '.pdf')
        if target.is_file() and target.read_bytes()[:4] == b'%PDF':
            continue
        base = 'https://notebrick.cn/app/api/jobs/' + job['id']
        headers = {'Authorization': 'Bearer ' + key}
        with urlopen(Request(base, headers=headers), timeout=45) as response:
            metadata = json.load(response)
        if metadata.get('status') != 'completed':
            raise ValueError(f"Note {job['id']} is {metadata.get('status')}: {metadata.get('error')}")
        with urlopen(Request(base + '/note.pdf?output=detailed%2Fnote.pdf&download=1', headers=headers), timeout=90) as response:
            data = response.read()
        if not data.startswith(b'%PDF'):
            raise ValueError('The download was not a PDF.')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        # Do not retain upstream video URLs, account data or other unrelated metadata.
        write(root / (job['id'] + '-status.json'), {'status': metadata['status'], 'title': metadata['title'],
              'coverage_note': metadata.get('coverage_note'), 'missing': metadata.get('missing')})
        print('PDF saved:', job['id'], flush=True)


def build(config):
    repo, work, root = (Path(config[name]) for name in ('repo', 'work', 'source'))
    slug = config['slug']
    stage = work / 'staging'
    destination = stage / 'static/notes' / slug
    current = repo / 'static/notes' / slug
    shared = repo / 'static/notes/_shared'
    if not (shared / 'notebook-app.js').is_file():
        raise ValueError('The target repository needs the shared notebook editor in static/notes/_shared/.')
    # A staging tree may be rebuilt. Only explicitly listed outputs are applied.
    existing = read(current / 'data/manifest.json') if (current / 'data/manifest.json').exists() else []
    notes = {entry['id']: read(current / 'data' / (entry['id'] + '.json')) for entry in existing}
    known = {note['sourceId'] for note in notes.values()}
    added = [job for job in config['jobs'] if job['id'] not in known]
    originals = {job['id']: source(root / (job['id'] + '.json')) for job in added}
    asset_map = extract_figures(root, added) if any(figure_count(s) for s in originals.values()) else {}
    destination.mkdir(parents=True, exist_ok=True)
    entries = list(existing)  # Preserve deliberate manual ordering and all edited note content.
    new_images = set()
    counts = {'blocks': 0, 'formulas': 0, 'figures': 0}
    for job in added:
        original = originals[job['id']]
        identifier = 'note-' + job['id']
        note = render_note(original, job, identifier, asset_map)
        for image in BeautifulSoup(note['html'], 'html.parser').select('img'):
            name = Path(image['src']).name
            target = destination / 'images' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            png = root / 'images' / Path(name).with_suffix('.png').name
            with Image.open(png) as picture:
                picture = picture.convert('RGB')
                picture.thumbnail((1600, 10000), Image.Resampling.LANCZOS)
                picture.save(target, 'WEBP', quality=95, method=6)
            new_images.add(target)
        result = validate_note(original, note, destination)
        for key in counts:
            counts[key] += result[key]
        notes[identifier] = note
        label = (job['recordingDate'][5:] + ' ') if job['recordingDate'] else ''
        entries.append({'id': identifier, 'title': label + note['title'], 'blocks': result['blocks']})
    files = []
    def output(relative, value, as_json=False):
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if as_json:
            write(target, value)
        else:
            target.write_text(value, encoding='utf-8')
        files.append(target)
    base = Path('static/notes') / slug
    for identifier, note in notes.items():
        relative = base / 'data' / (identifier + '.json')
        original_file = current / 'data' / (identifier + '.json')
        if original_file.is_file():
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original_file, target)
            files.append(target)
        else:
            output(relative, note, True)
    output(base / 'data/manifest.json', entries, True)
    course = read(current / 'course.json') if (current / 'course.json').exists() else {
        'title': config['title'] + ('' if config['title'].endswith('笔记') else '笔记'), 'slug': slug,
        'repository': config['repository'], 'branch': config['branch'], 'directory': f'static/notes/{slug}',
        'draftKey': slug + '-note-draft-v1:', 'collapseKey': slug + '-courses-collapsed'}
    output(base / 'course.json', course, True)
    engine_hash, css_hash = digest(shared / 'notebook-app.js')[:10], digest(shared / 'notebook.css')[:10]
    output(base / 'app.js', "import { startNotebook } from '../_shared/notebook-app.js?v=" + engine_hash + "';\nstartNotebook(" + json.dumps(course, ensure_ascii=False, indent=2) + ");\n")
    output(base / 'style.css', "@import url('../_shared/notebook.css?v=" + css_hash + "');\n")
    template = current / 'index.html' if (current / 'index.html').exists() else repo / 'static/notes/automatic-control/index.html'
    markup = template.read_text(encoding='utf-8')
    if not current.exists():
        old_title = read(repo / 'static/notes/automatic-control/course.json')['title']
        markup = markup.replace(html.escape(old_title), html.escape(course['title']))
    for filename in ('app.js', 'style.css'):
        markup = re.sub(re.escape(filename) + r'\?v=[a-f0-9]+', filename + '?v=' + digest(destination / filename)[:10], markup)
    output(base / 'index.html', markup)
    content = Path('content/notes') / slug / 'index.md'
    if not (repo / content).exists():
        from datetime import datetime
        from zoneinfo import ZoneInfo
        date = datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')
        output(content, '---\ntitle: ' + json.dumps(config['title'], ensure_ascii=False) + '\nsummary: 可编辑的课程笔记，支持章节目录与 GitHub 同步\ndate: ' + date + '\ntype: notebook\nnotebook_slug: ' + slug + '\n---\n')
        layout = Path('layouts/notebook/single.html')
        if not (repo / layout).exists():
            output(layout, '{{ readFile (printf "static/notes/%s/index.html" .Params.notebook_slug) | safeHTML }}\n')
    files.extend(sorted(new_images))
    report = {'version': 1, 'slug': slug, 'configHash': hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest(),
              'added': len(added), 'preserved': len(existing), 'total': len(entries),
              'counts': counts, 'files': [{'path': file.relative_to(stage).as_posix(),
              'base': digest(repo / file.relative_to(stage)), 'sha256': digest(file)} for file in files]}
    write(work / 'build-report.json', report)
    print(json.dumps({k: v for k, v in report.items() if k != 'files'}, ensure_ascii=False, indent=2))


def apply(config):
    repo, work = Path(config['repo']).resolve(), Path(config['work'])
    report = read(work / 'build-report.json')
    if report['configHash'] != hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest():
        raise ValueError('The import plan changed after staging. Run build again.')
    allowed = ('static/notes/' + config['slug'] + '/', 'content/notes/' + config['slug'] + '/')
    for item in report['files']:
        relative = item['path']
        if Path(relative).is_absolute() or '..' in Path(relative).parts or '\\' in relative:
            raise ValueError('Invalid output path: ' + relative)
        if not (relative.startswith(allowed) or relative == 'layouts/notebook/single.html'):
            raise ValueError('Unexpected output path: ' + relative)
        target = (repo / relative).resolve()
        if not target.is_relative_to(repo) or digest(target) != item['base']:
            raise ValueError('Local files changed after staging; rebuild before applying: ' + relative)
        staged = work / 'staging' / relative
        if digest(staged) != item['sha256']:
            raise ValueError('Staged content changed; rebuild before applying: ' + relative)
    changed = 0
    for item in report['files']:
        if item['base'] == item['sha256']:
            continue
        target = repo / item['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.notebrick-', delete=False) as temporary:
            temporary.write((work / 'staging' / item['path']).read_bytes())
            temporary_name = temporary.name
        os.replace(temporary_name, target)
        changed += 1
    print(f'Applied {changed} files locally. Review, build and deploy through the repository workflow.')


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    command = sub.add_parser('init')
    for name in ('repo', 'work', 'slug', 'title', 'sources'):
        command.add_argument('--' + name, required=True)
    command.add_argument('--source-dir')
    command.add_argument('--repository')
    command.add_argument('--branch', default='main')
    for name in ('status', 'add', 'download', 'build', 'apply'):
        command = sub.add_parser(name)
        command.add_argument('--config', required=True)
        if name == 'download':
            command.add_argument('--key-stdin', action='store_true')
        if name == 'add':
            command.add_argument('--sources', required=True)
    args = parser.parse_args()
    if args.command == 'init':
        init(args)
    else:
        config = read(args.config)
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', config['slug']):
            raise ValueError('Invalid course slug in import config.')
        if any(not re.fullmatch(r'[a-f0-9]{24,64}', job['id']) for job in config['jobs']):
            raise ValueError('Invalid source ID in import config.')
        if args.command == 'add':
            known = {job['id'] for job in config['jobs']}
            extra = [job for job in read_jobs(args.sources) if job['id'] not in known]
            config['jobs'].extend(extra)
            write(args.config, config)
            print(f'Added {len(extra)} new source IDs; prior jobs and checkpoints retained.')
            return
        if args.command == 'download':
            key = sys.stdin.readline().strip() if args.key_stdin else os.environ.get('NOTEBRICK_API_KEY') or getpass.getpass('Existing NoteBrick API key: ')
            download(config, key)
        else:
            {'status': status, 'build': build, 'apply': apply}[args.command](config)


if __name__ == '__main__':
    main()
