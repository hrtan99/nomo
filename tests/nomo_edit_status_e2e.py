#!/usr/bin/env python3
"""Inspect a copied synthetic edit journal using the public status entry."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-db', type=Path, required=True)
    parser.add_argument('--expected-source-sha256', required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    args = parser.parse_args()
    assert args.source_db.is_file() and not args.source_db.is_symlink() and sha(args.source_db) == args.expected_source_sha256
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='edit-status-', dir=args.evidence_dir))
    state = out/'state'; state.mkdir(mode=0o700)
    db = state/'edit.sqlite3'; shutil.copyfile(args.source_db,db); db.chmod(0o600)
    env = os.environ.copy(); env.update(NOMO_ETAS_VERSION='0.2.3', NOMO_QWEN_SERVER_API_KEY='SYNTHETIC_ONLY', NOMO_READ_MODEL_BASE_URL='http://synthetic.invalid')
    result = {'status':'failed','scope':'copied synthetic completed edit journal; not current-file verification or session resume'}
    try:
        with sqlite3.connect(db.as_uri()+'?mode=ro',uri=True) as connection:
            before = list(connection.iterdump())
        def invoke(operation):
            return subprocess.run([str(ROOT/'scripts/nomo-read.sh'),'edit-status','--state',str(state),'--id',operation,'--path','note.txt'],
                                  stdin=subprocess.DEVNULL,capture_output=True,env=env,timeout=90)
        good = invoke('owned-edit');(out/'status.stdout').write_bytes(good.stdout);(out/'status.stderr').write_bytes(good.stderr)
        assert good.returncode == 0
        lines = good.stdout.decode().splitlines()
        assert len(lines) == 2 and lines[0].startswith('OPERATION ')
        record = json.loads(lines[0][len('OPERATION '):])
        assert record['phase'] == 'completed' and record['id'] == 'owned-edit' and record['path'] == 'note.txt'
        assert lines[1] == 'Recorded operation only; current file state is not checked.'
        wrong = invoke('different');(out/'wrong.stdout').write_bytes(wrong.stdout);(out/'wrong.stderr').write_bytes(wrong.stderr)
        assert wrong.returncode != 0 and b'REFUSED ' in wrong.stdout and b'OPERATION ' not in wrong.stdout
        with sqlite3.connect(db.as_uri()+'?mode=ro',uri=True) as connection:
            after = list(connection.iterdump())
        assert before == after and sha(args.source_db) == args.expected_source_sha256
        result.update(status='passed',correct_exit=good.returncode,wrong_selector_exit=wrong.returncode,
                      recorded_phase=record['phase'],logical_database_unchanged=True,source_copy_unchanged=True)
    except BaseException as error:
        result.update(failure_type=type(error).__name__,failure=str(error))
    (out/'result.json').write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'status':result['status'],'evidence':str(out)}))
    return 0 if result['status']=='passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
