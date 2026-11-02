"""Public project-check entry, using a synthetic Docker command."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / 'scripts/nomo-read.sh'


class ProjectCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nomo-project-check-')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.workspace = base / 'workspace'
        self.workspace.mkdir(mode=0o700)
        self.bin = base / 'bin'
        self.bin.mkdir()
        self.log = base / 'docker.json'
        docker = self.bin / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json,os,sys
if sys.argv[1:2] == ['inspect']:
    print('No such object: synthetic', file=sys.stderr);sys.exit(1)
with open(os.environ['NOMO_TEST_LOG'], 'w') as f:
    json.dump({'args': sys.argv[1:], 'workspace': os.environ.get('NOMO_EDIT_WORKSPACE_DIR'),
               'model_key': 'NOMO_QWEN_SERVER_API_KEY' in os.environ,
               'model_url': 'NOMO_READ_MODEL_BASE_URL' in os.environ,
               'model_deadline': 'NOMO_MODEL_REQUEST_DEADLINE_MS' in os.environ,
               'host_override': 'ETAS_HOST_POLICY' in os.environ}, f)
sys.exit(int(os.environ.get('NOMO_TEST_EXIT', '0')))
''')
        docker.chmod(0o755)
        self.env = {'PATH': str(self.bin) + ':/usr/bin:/bin', 'HOME': str(base),
                    'NOMO_TEST_LOG': str(self.log), 'NOMO_ETAS_VERSION': '0.2.3',
                    'NOMO_QWEN_SERVER_API_KEY': 'synthetic', 'NOMO_READ_MODEL_BASE_URL': 'http://synthetic',
                    'NOMO_MODEL_REQUEST_DEADLINE_MS': '240000',
                    'ETAS_HOST_POLICY': 'unsafe'}

    def invoke(self, *args, env=None):
        return subprocess.run(['bash', str(LAUNCHER), 'check', *map(str, args)],
                              stdin=subprocess.DEVNULL, capture_output=True, env=env or self.env, timeout=15)

    def test_check_routes_literal_argv_without_provider_or_state(self):
        result = self.invoke('--root', self.workspace, '--', 'python3', '-c', 'print("ok")')
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads(self.log.read_text())
        self.assertEqual(call['workspace'], str(self.workspace.resolve()))
        self.assertFalse(call['model_key'] or call['model_url'] or call['model_deadline'] or call['host_override'])
        self.assertIn(str(ROOT / 'config/etas-023-official-compose.yaml'), call['args'])
        self.assertIn(str(ROOT / 'config/nomo-project-check-compose.yaml'), call['args'])
        self.assertNotIn(str(ROOT / 'config/nomo-model-edit-compose.yaml'), call['args'])
        self.assertNotIn(str(ROOT / 'config/edit-operation-compose.yaml'), call['args'])
        self.assertIn('--tty=false', call['args'])
        self.assertEqual(call['args'][-7:], ['/usr/bin/timeout', '--signal=TERM', '--kill-after=2s', '60s', 'python3', '-c', 'print("ok")'])
        self.assertIn(b'Check passed.', result.stdout)

    def test_024_check_uses_the_selected_overlay(self):
        result = self.invoke('--root', self.workspace, '--', 'true', env=dict(self.env, NOMO_ETAS_VERSION='0.2.4'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(ROOT/'config/etas-024-official-compose.yaml'), json.loads(self.log.read_text())['args'])

    def test_failed_check_is_reported_and_exit_propagated(self):
        result = self.invoke('--root', self.workspace, '--', 'false', env=dict(self.env, NOMO_TEST_EXIT='7'))
        self.assertEqual(result.returncode, 7)
        self.assertIn(b'Check failed or could not be completed (exit 7)', result.stderr)
        self.assertNotIn(b'Check passed.', result.stdout)

    def test_invalid_requests_never_launch(self):
        self.assertEqual(self.invoke('--root', self.workspace, '--').returncode, 64)
        self.assertFalse(self.log.exists())
        self.workspace.chmod(0o755)
        self.assertEqual(self.invoke('--root', self.workspace, '--', 'true').returncode, 64)
        self.assertFalse(self.log.exists())
        self.workspace.chmod(0o700)
        link = self.workspace.parent / 'link'
        link.symlink_to(self.workspace, target_is_directory=True)
        self.assertEqual(self.invoke('--root', link, '--', 'true').returncode, 64)
        self.assertFalse(self.log.exists())
        result = self.invoke('--root', self.workspace, '--', 'true', env=dict(self.env, NOMO_ETAS_VERSION='invalid'))
        self.assertEqual(result.returncode, 64)
        self.assertFalse(self.log.exists())


if __name__ == '__main__':
    unittest.main()
