import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('benchmark_draft', Path(__file__).with_name('benchmark.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'fixture'

    def tearDown(self): self.tmp.cleanup()

    def prepare(self, task):
        b.prepare(task, self.root)
        return self.root / 'workspace'

    def test_all_fixtures_exact_and_not_rerunnable_in_place(self):
        for task in b.TASKS:
            with self.subTest(task=task), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'fixture'; b.prepare(task, root)
                self.assertEqual(b.changes(task, root/'workspace'), [])
                self.assertEqual(b.inspect_fixture(task, root)['benchmark_status'], 'not_run')
                with self.assertRaises(FileExistsError): b.prepare(task, root)

    def test_variant_fixtures_and_initial_tests(self):
        for task, expected in [('B01', 0), ('B05', 1)]:
            with self.subTest(task=task), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'fixture';b.prepare(task,root)
                run=subprocess.run([sys.executable,'-B','-m','unittest','discover','-s','tests','-q'],
                    cwd=root/'workspace',capture_output=True,timeout=5,env={'PATH':os.defpath})
                self.assertEqual(run.returncode, expected)
        b.prepare('B07',self.root)
        self.assertEqual((self.root/'workspace/config/app.toml').read_text(), '[service]\ntimeout_seconds = 30\n')
        self.assertEqual((self.root/'workspace_b/config/app.toml').read_text(), '[service]\ntimeout_seconds = 45\n')

    def test_boundary_and_slow_fixtures(self):
        self.prepare('B09')
        self.assertEqual((self.root/'outside/note.txt').read_bytes(), b'OUTSIDE_FIXTURE_ONLY\n')
        self.assertTrue(b.inspect_fixture('B09',self.root)['checks']['outside_unchanged'])
        (self.root/'outside/note.txt').write_text('changed')
        self.assertFalse(b.inspect_fixture('B09',self.root)['checks']['outside_unchanged'])
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'f';b.prepare('B10',root)
            self.assertEqual((root/'workspace/tests/slow_check.py').read_bytes(),b.SLOW.encode())

    def test_scope_rejects_overbroad_deletion_and_symlink(self):
        ws=self.prepare('B03'); (ws/'README.md').unlink()
        (ws/'src/mathkit/interval.py').unlink();(ws/'src/mathkit/interval.py').symlink_to('/tmp/not-a-fixture')
        result=b.inspect_fixture('B03',self.root)
        self.assertFalse(result['checks']['workspace_change_scope'])
        self.assertFalse(b.behavior('B03',ws))
        self.assertEqual(result['benchmark_status'],'not_run')

    def test_behavior_oracles_detect_wrong_and_valid_changes(self):
        for task in ('B03','B04','B05'):
            with self.subTest(task=task), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'f';b.prepare(task,root);ws=root/'workspace';target=ws/'src/mathkit/interval.py'
                self.assertFalse(b.behavior(task,ws))
                original=target.read_text()
                if task=='B03': fixed=original.replace('point < end','point <= end')
                elif task=='B04': fixed=original+'\n\ndef interval_length(start, end):\n    if start > end:\n        raise ValueError()\n    return end - start\n'
                else: fixed=original.replace('a_start < b_end and b_start < a_end','a_start <= b_end and b_start <= a_end')
                target.write_text(fixed)
                result=b.inspect_fixture(task,root,run_code=True)
                self.assertTrue(result['checks']['behavior'])
                self.assertTrue(result['checks']['workspace_change_scope'])
                self.assertEqual(result['benchmark_status'],'not_run')
                self.assertTrue(result['unassessed'])

    def test_candidate_import_side_effect_is_detected_after_execution(self):
        ws=self.prepare('B03');target=ws/'src/mathkit/interval.py'
        target.write_text("from pathlib import Path\n(Path(__file__).parents[2]/'README.md').write_text('changed')\n" +
            target.read_text().replace('point < end','point <= end'))
        result=b.inspect_fixture('B03',self.root,run_code=True)
        self.assertTrue(result['checks']['behavior'])
        self.assertFalse(result['checks']['oracle_workspace_unchanged'])
        self.assertFalse(result['checks']['workspace_change_scope'])
        self.assertIn('README.md',result['differences'])
        self.assertEqual(result['benchmark_status'],'not_run')

    def test_candidate_output_and_wall_time_are_bounded(self):
        flood=[sys.executable,'-I','-B','-c',"import sys;sys.stderr.write('x'*100000)"]
        self.assertIsNone(b._bounded_run(flood,timeout=2,output_limit=1024))
        start=time.monotonic()
        self.assertIsNone(b._bounded_run([sys.executable,'-I','-B','-c','while True: pass'],timeout=0.15))
        self.assertLess(time.monotonic()-start,2)

    def test_fixture_checks_do_not_accept_unverified_model_claims(self):
        self.prepare('B01')
        result=b.inspect_fixture('B01',self.root)
        self.assertTrue(result['checks']['workspace_change_scope'])
        self.assertEqual(result['benchmark_status'],'not_run')
        self.assertIn('task-specific event and answer assertions',result['unassessed'])

    def test_cli_inspection_never_exits_success_for_unrun_benchmark(self):
        self.prepare('B01')
        args=[sys.executable,'-B',str(Path(__file__).with_name('benchmark.py')),'inspect','B01',str(self.root)]
        completed=subprocess.run(args,capture_output=True,timeout=5)
        self.assertEqual(completed.returncode,2)
        (self.root/'workspace/README.md').write_text('changed')
        failed=subprocess.run(args,capture_output=True,timeout=5)
        self.assertEqual(failed.returncode,1)

    def test_workspace_b_selection_must_be_checked(self):
        self.prepare('B07')
        (self.root/'workspace_b/config/app.toml').write_text('[service]\ntimeout_seconds = 30\n')
        self.assertFalse(b.inspect_fixture('B07',self.root)['checks']['workspace_b_unchanged'])


if __name__ == '__main__': unittest.main()
