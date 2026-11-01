"""Exercise versioned Docker routing without contacting Docker or a network."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'scripts/etas-022-official-container.sh'


class OfficialContainerRouting(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='etas022-routing-')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.log = base / 'docker.json'
        docker = base / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json,os,sys
with open(os.environ['NOMO_TEST_LOG'], 'w') as output:
    json.dump(sys.argv[1:], output)
''')
        docker.chmod(0o755)
        self.env = {'PATH': str(base) + ':/usr/bin:/bin', 'HOME': str(base), 'NOMO_TEST_LOG': str(self.log)}

    def invoke(self, *arguments):
        return subprocess.run(['bash', str(SCRIPT), *arguments], env=self.env,
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=10)

    def test_prepare_selects_networked_dependency_service(self):
        result = self.invoke('prepare')
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.log.read_text())
        self.assertEqual(args[:3], ['compose', '--env-file', '/dev/null'])
        self.assertIn(str(ROOT / 'config/etas-022-official-compose.yaml'), args)
        self.assertIn('--profile', args)
        self.assertEqual(args[-5:], ['dependency', 'python3', '-B', '/workspace/scripts/etas-022-official-cli-bootstrap.py', 'prepare'])

    def test_verify_and_register_use_dev_service(self):
        for mode in ('verify', 'register-existing'):
            with self.subTest(mode=mode):
                result = self.invoke(mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                args = json.loads(self.log.read_text())
                self.assertNotIn('--profile', args)
                self.assertIn('dev', args)
                self.assertIn(mode, args)
                if mode == 'register-existing':
                    self.assertEqual(args[-2:], ['--binary', '/home/nomo/.cargo/etas-latest/target/release/etas'])

    def test_invalid_mode_does_not_dispatch(self):
        result = self.invoke('unknown')
        self.assertEqual(result.returncode, 64)
        self.assertFalse(self.log.exists())


if __name__ == '__main__':
    unittest.main()
