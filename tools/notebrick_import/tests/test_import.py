import argparse
import contextlib
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from tools.notebrick_import.__main__ import init, build, apply, read, write, source
from tools.notebrick_import.render import render_note


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'repo'
        self.work = self.root / 'work'
        self.raw = self.root / 'raw'
        actual = Path(__file__).resolve().parents[3]
        for name in ('notebook-app.js', 'notebook.css'):
            target = self.repo / 'static/notes/_shared' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(actual / 'static/notes/_shared' / name, target)
        for name in ('index.html', 'course.json'):
            target = self.repo / 'static/notes/automatic-control' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(actual / 'static/notes/automatic-control' / name, target)
        self.jobs = self.root / 'jobs.json'
        write(self.jobs, [{'id': 'a' * 32, 'recordingDate': '2026-09-01'}])
        self.note('a' * 32)
        with contextlib.redirect_stdout(io.StringIO()):
            init(argparse.Namespace(repo=str(self.repo), work=str(self.work), slug='course', title='课程',
                sources=str(self.jobs), source_dir=str(self.raw), repository='example/notes', branch='main'))
        self.config = read(self.work / 'import.json')

    def note(self, identifier):
        write(self.raw / (identifier + '.json'), {'title': '章节与公式', 'blocks': [
            {'id': 'heading', 'kind': 'section', 'read': {'title': [{'t': 'text', 'v': '章节'}]}},
            {'id': 'text', 'kind': 'paragraph', 'read': {'body': [
                {'t': 'p', 'c': [{'t': 'text', 'v': '保留原文'}, {'t': 'math', 'latex': 'x^2\\ '}]},
                {'t': 'code', 'text': 'print("你好")'}]}}]})

    def run_build(self):
        with contextlib.redirect_stdout(io.StringIO()):
            build(self.config)

    def run_apply(self):
        with contextlib.redirect_stdout(io.StringIO()):
            apply(self.config)

    def test_incremental_preserves_edited_bytes_and_ids(self):
        self.run_build()
        self.run_apply()
        folder = self.repo / 'static/notes/course/data'
        listing = read(folder / 'manifest.json')
        self.assertEqual(listing[0]['id'], 'note-' + 'a' * 32)
        existing = folder / (listing[0]['id'] + '.json')
        note = read(existing)
        note['html'] += '<p>网页上的新修改</p>'
        saved = (json.dumps(note, ensure_ascii=False, indent=1) + '\r\n').encode()
        existing.write_bytes(saved)
        self.note('b' * 32)
        self.config['jobs'].append({'id': 'b' * 32, 'title': '', 'recordingDate': '2026-09-02'})
        self.run_build()
        report = read(self.work / 'build-report.json')
        self.assertEqual((report['added'], report['preserved']), (1, 1))
        self.run_apply()
        self.assertEqual(existing.read_bytes(), saved)
        self.assertEqual(len(read(folder / 'manifest.json')), 2)

    def test_stale_target_cannot_be_overwritten(self):
        self.run_build()
        self.run_apply()
        self.run_build()
        existing = self.repo / ('static/notes/course/data/note-' + 'a' * 32 + '.json')
        saved = existing.read_bytes() + b'\n'
        existing.write_bytes(saved)
        with self.assertRaisesRegex(ValueError, 'changed after staging'):
            self.run_apply()
        self.assertEqual(existing.read_bytes(), saved)

    def test_stale_import_plan_cannot_be_applied(self):
        self.run_build()
        self.config['title'] = '改变后的课程'
        with self.assertRaisesRegex(ValueError, 'plan changed'):
            self.run_apply()

    def test_truncated_and_unknown_content_stop_conversion(self):
        self.note('b' * 32)
        path = self.raw / ('b' * 32 + '.json')
        value = read(path)
        value['blocks'][0]['read']['title'] = '[MaxDepth]'
        write(path, value)
        with self.assertRaisesRegex(ValueError, 'Truncated'):
            source(path)
        value['blocks'][0]['read']['title'] = [{'t': 'unknown-widget'}]
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            render_note(value, {'id': 'b' * 32}, 'note', {})

    def test_identical_copied_block_ids_are_preserved(self):
        path = self.raw / ('a' * 32 + '.json')
        value = read(path)
        value['blocks'].append(json.loads(json.dumps(value['blocks'][1])))
        write(path, value)
        self.assertEqual(len(source(path)['blocks']), 3)
        value['blocks'][-1]['read']['body'][0]['c'][0]['v'] = '另一段内容'
        write(path, value)
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            source(path)


if __name__ == '__main__':
    unittest.main()
