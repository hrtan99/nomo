"""Host-only launcher integration with a synthetic Docker executable."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / 'scripts/nomo-read.sh'


class ReadLauncher(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nomo-read-launcher-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.read_root = self.base / 'context'
        self.read_root.mkdir()
        bindir = self.base / 'bin'
        bindir.mkdir()
        self.log = self.base / 'docker.json'
        docker = bindir / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json,os,sys
if sys.argv[1:2] == ['inspect']:
    print('No such object: synthetic',file=sys.stderr);sys.exit(1)
with open(os.environ['NOMO_TEST_LOG'],'w') as f:
    json.dump({'args':sys.argv[1:],'root':os.environ.get('NOMO_READ_ROOT'),
               'key_present':bool(os.environ.get('NOMO_QWEN_SERVER_API_KEY'))},f)
''')
        docker.chmod(0o755)
        self.env = {'PATH': str(bindir) + ':/usr/bin:/bin', 'HOME': str(self.base),
                    'NOMO_TEST_LOG': str(self.log), 'NOMO_MODEL_PROVIDER': 'qwen', 'NOMO_READ_MODEL_BASE_URL': 'http://synthetic:9999/v1',
                    'NOMO_QWEN_SERVER_API_KEY': 'SYNTHETIC_PRIVATE_TOKEN'}

    def invoke(self, *args, env=None):
        return subprocess.run(['bash', str(LAUNCHER), *map(str, args)], env=env or self.env,
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=15)

    def test_ask_routes_bounded_read_only_flow(self):
        result = self.invoke('ask', '--root', self.read_root, '--allow', 'notes/a.txt', '--once', 'What changed?')
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads(self.log.read_text())
        self.assertEqual(call['root'], str(self.read_root))
        self.assertTrue(call['key_present'])
        self.assertNotIn('SYNTHETIC_PRIVATE_TOKEN', json.dumps(call['args']))
        self.assertIn(str(ROOT / 'config/etas-030-official-compose.yaml'), call['args'])
        self.assertIn('/workspace/scripts/nomo-verified-etas.py', call['args'])
        self.assertEqual(call['args'][-12:], ['etas', 'run', '/workspace', '--flow', 'read_model_tools',
                         '--profile', 'gateway-qwen-readonly', '--allow-effects', '--args',
                         'new', '--allow', 'notes/a.txt', '--once', 'What changed?'][-12:])
        self.assertIn('--tty=false', call['args'])

    def test_chat_uses_fresh_in_memory_flow(self):
        result = self.invoke('chat', '--root', self.read_root, '--allow', 'a.txt,b.txt')
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads(self.log.read_text())
        self.assertIn('read_model_tools_chat', call['args'])
        self.assertEqual(call['args'][-3:], ['new', '--allow', 'a.txt,b.txt'])

    def test_four_turns_opt_in_and_invalid_value(self):
        result = self.invoke('chat', '--root', self.read_root, '--allow', 'a.txt', '--turns', '4')
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads(self.log.read_text())
        self.assertEqual(call['args'][-5:], ['new', '--allow', 'a.txt', '--turns', '4'])
        self.log.unlink()
        result = self.invoke('chat', '--root', self.read_root, '--allow', 'a.txt', '--turns', '3')
        self.assertEqual(result.returncode, 64)
        self.assertFalse(self.log.exists())

    def test_explicit_030_and_unknown_version(self):
        env = dict(self.env, NOMO_ETAS_VERSION='0.3.0')
        result = self.invoke('chat', '--root', self.read_root, '--allow', 'a.txt', env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(ROOT / 'config/etas-030-official-compose.yaml'), json.loads(self.log.read_text())['args'])
        self.log.unlink()
        env['NOMO_ETAS_VERSION'] = 'unsupported'
        result = self.invoke('chat', '--root', self.read_root, '--allow', 'a.txt', env=env)
        self.assertEqual(result.returncode, 64)
        self.assertFalse(self.log.exists())

    def test_previous_runtime_is_refused_before_docker(self):
        env = dict(self.env, NOMO_ETAS_VERSION='0.2.6')
        result = self.invoke('chat', '--root', self.read_root, '--allow', 'a.txt', env=env)
        self.assertEqual(result.returncode, 64)
        self.assertFalse(self.log.exists())

    def test_missing_configuration_and_bad_root_fail_before_docker(self):
        env = self.env.copy()
        del env['NOMO_QWEN_SERVER_API_KEY']
        result = self.invoke('chat', '--root', self.read_root, '--allow', 'a.txt', env=env)
        self.assertEqual(result.returncode, 64)
        self.assertFalse(self.log.exists())
        link = self.base / 'link'
        link.symlink_to(self.read_root, target_is_directory=True)
        result = self.invoke('chat', '--root', link, '--allow', 'a.txt')
        self.assertEqual(result.returncode, 64)
        self.assertFalse(self.log.exists())

    def test_help_does_not_require_provider_or_docker(self):
        result = self.invoke('--help', env={'PATH': '/usr/bin:/bin', 'HOME': str(self.base)})
        self.assertEqual(result.returncode, 0)
        self.assertIn(b'not a durable session', result.stdout)
        self.assertIn(b'resume --id SESSION_ID  (not available yet)', result.stdout)
        self.assertFalse(self.log.exists())

    def test_resume_refuses_before_opening_state_or_launching_docker(self):
        state = self.base / 'must-not-be-created'
        isolated = self.base / 'project' / 'scripts' / 'nomo-read.sh'
        isolated.parent.mkdir(parents=True)
        shutil.copyfile(LAUNCHER, isolated)
        env = {'PATH': self.env['PATH'], 'HOME': str(self.base), 'NOMO_TEST_LOG': str(self.log)}
        result = subprocess.run(['bash', str(isolated), 'resume', '--id', 'synthetic-session',
                                 '--state', str(state)], env=env, stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(result.stderr, b'Session resume is not available yet.\n')
        self.assertFalse(state.exists())
        self.assertFalse((isolated.parent.parent / '.etas').exists())
        self.assertFalse(self.log.exists())


if __name__ == '__main__':
    unittest.main()
