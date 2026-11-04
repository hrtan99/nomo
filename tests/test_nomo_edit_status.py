"""Public edit-status entry tested with a synthetic Docker client."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class EditStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nomo-status-')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.state = base / 'state'
        self.state.mkdir(mode=0o700)
        (self.state / 'edit.sqlite3').write_bytes(b'synthetic')
        self.bin = base / 'bin'
        self.bin.mkdir()
        self.log = base / 'docker.json'
        docker = self.bin / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json,os,sys
if sys.argv[1:2] == ['inspect']:
    print('No such object: synthetic', file=sys.stderr);sys.exit(1)
with open(os.environ['NOMO_TEST_LOG'], 'w') as f:
    json.dump({'args':sys.argv[1:], 'state':os.environ.get('NOMO_EDIT_STATE_DIR'),
               'key':'NOMO_QWEN_SERVER_API_KEY' in os.environ,
               'url':'NOMO_READ_MODEL_BASE_URL' in os.environ,
               'deadline':'NOMO_MODEL_REQUEST_DEADLINE_MS' in os.environ,
               'host':'ETAS_HOST_POLICY' in os.environ},f)
sys.exit(int(os.environ.get('NOMO_TEST_EXIT','0')))
''')
        docker.chmod(0o755)
        self.env = {'PATH':str(self.bin)+':/usr/bin:/bin','HOME':str(base), 'NOMO_TEST_LOG':str(self.log),
                    'NOMO_ETAS_VERSION':'0.3.0','NOMO_QWEN_SERVER_API_KEY':'synthetic',
                    'NOMO_MODEL_REQUEST_DEADLINE_MS':'240000',
                    'NOMO_READ_MODEL_BASE_URL':'http://synthetic','ETAS_HOST_POLICY':'unsafe'}

    def invoke(self, *args, env=None):
        return subprocess.run(['bash',str(ROOT/'scripts/nomo-read.sh'),'edit-status',*map(str,args)],
                              stdin=subprocess.DEVNULL,capture_output=True,env=env or self.env,timeout=15)

    def test_non_tty_routes_record_status_without_model_or_file_mount(self):
        result = self.invoke('--state',self.state,'--id','owned-edit','--path','note.txt')
        self.assertEqual(result.returncode,0,result.stderr)
        call = json.loads(self.log.read_text())
        self.assertEqual(call['state'],str(self.state.resolve()))
        self.assertFalse(call['key'] or call['url'] or call['deadline'] or call['host'])
        self.assertIn(str(ROOT/'config/nomo-edit-status-compose.yaml'),call['args'])
        self.assertNotIn(str(ROOT/'config/nomo-model-edit-compose.yaml'),call['args'])
        self.assertNotIn(str(ROOT/'config/edit-operation-compose.yaml'),call['args'])
        self.assertIn('--tty=false',call['args'])
        self.assertEqual(call['args'][-8:],['--allow-effects','--args','--id','owned-edit','--workspace','private-workspace','--path','note.txt'])

    def test_030_status_uses_the_selected_overlay(self):
        result = self.invoke('--state', self.state, '--id', 'owned-edit', '--path', 'note.txt',
                             env=dict(self.env, NOMO_ETAS_VERSION='0.3.0'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(ROOT/'config/etas-030-official-compose.yaml'), json.loads(self.log.read_text())['args'])

    def test_missing_db_unsafe_state_and_sidecars_refuse_before_docker(self):
        db = self.state/'edit.sqlite3'
        db.unlink()
        self.assertEqual(self.invoke('--state',self.state,'--id','x','--path','y').returncode,64)
        self.assertFalse(self.log.exists())
        db.write_text('synthetic')
        (self.state/'edit.sqlite3-wal').symlink_to(db)
        self.assertEqual(self.invoke('--state',self.state,'--id','x','--path','y').returncode,64)
        self.assertFalse(self.log.exists())
        (self.state/'edit.sqlite3-wal').unlink()
        self.state.chmod(0o755)
        self.assertEqual(self.invoke('--state',self.state,'--id','x','--path','y').returncode,64)
        self.assertFalse(self.log.exists())

    def test_launcher_failure_is_propagated(self):
        result = self.invoke('--state',self.state,'--id','x','--path','y',env=dict(self.env,NOMO_TEST_EXIT='7'))
        self.assertEqual(result.returncode,7)


if __name__ == '__main__':
    unittest.main()
