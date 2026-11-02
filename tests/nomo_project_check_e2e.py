#!/usr/bin/env python3
"""Exercise standalone project checks in a disposable workspace, without a model."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence-dir', type=Path, required=True)
    args = parser.parse_args()
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='project-check-', dir=args.evidence_dir))
    workspace = out / 'workspace'
    workspace.mkdir(mode=0o700)
    (workspace / 'input.txt').write_text('project fixture\n')
    env = os.environ.copy()
    env.update(NOMO_ETAS_VERSION='0.2.3', NOMO_QWEN_SERVER_API_KEY='SYNTHETIC_ONLY',
               NOMO_READ_MODEL_BASE_URL='http://synthetic.invalid')
    script = '''import json,os,pathlib,time
p=pathlib.Path('.')
assert (p/'input.txt').read_text() == 'project fixture\\n'
(p/'started').write_text('ready')
for _ in range(150):
 if (p/'release').exists(): break
 time.sleep(.1)
else: raise RuntimeError('inspection was not released')
(p/'observed.json').write_text(json.dumps({'cwd':os.getcwd(),'model_key':'NOMO_QWEN_SERVER_API_KEY' in os.environ,'model_url':'NOMO_READ_MODEL_BASE_URL' in os.environ,'state':os.path.exists('/state')}))
'''
    cmd = [str(ROOT / 'scripts/nomo-read.sh'), 'check', '--root', str(workspace), '--', 'python3', '-c', script]
    result = {'status': 'failed', 'scope': 'standalone synthetic project check; no model, operation state or session'}
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
    try:
        deadline = time.monotonic() + 60
        while not (workspace / 'started').exists():
            if proc.poll() is not None: raise RuntimeError('check exited before inspection')
            if time.monotonic() >= deadline: raise TimeoutError('check did not start')
            time.sleep(.1)
        listing = subprocess.run(['docker','ps','-q','--filter','label=nomo.terminal.invocation'], check=True, capture_output=True, text=True, timeout=5)
        matches = []
        for identifier in listing.stdout.split():
            query = subprocess.run(['docker','inspect',identifier], check=True, capture_output=True, text=True, timeout=5)
            details = json.loads(query.stdout)[0]
            mounts = {m['Destination']: m for m in details['Mounts']}
            if mounts.get('/edit-fixture',{}).get('Source') in (str(workspace), '/host_mnt'+str(workspace)):
                matches.append((details, mounts))
        assert len(matches) == 1
        details, mounts = matches[0]
        assert details['HostConfig']['NetworkMode'] == 'none' and mounts['/edit-fixture']['RW']
        assert not mounts['/workspace']['RW'] and not mounts['/home/nomo/.cargo']['RW'] and '/state' not in mounts
        result['container'] = {'network': details['HostConfig']['NetworkMode'], 'workspace_writable': mounts['/edit-fixture']['RW'],
                               'source_readonly': not mounts['/workspace']['RW'], 'cache_readonly': not mounts['/home/nomo/.cargo']['RW'], 'state_mounted': '/state' in mounts}
        (workspace / 'release').touch()
        stdout, stderr = proc.communicate(timeout=30)
        (out/'success.stdout').write_bytes(stdout); (out/'success.stderr').write_bytes(stderr)
        observed = json.loads((workspace/'observed.json').read_text())
        assert proc.returncode == 0 and b'Check passed.' in stdout
        assert observed == {'cwd': '/edit-fixture', 'model_key': False, 'model_url': False, 'state': False}
        result['success'] = {'exit': proc.returncode, 'observed': observed}
        fail = subprocess.run([str(ROOT/'scripts/nomo-read.sh'), 'check', '--root', str(workspace), '--', 'python3', '-c', 'raise SystemExit(7)'],
                              stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=90)
        (out/'failure.stdout').write_bytes(fail.stdout); (out/'failure.stderr').write_bytes(fail.stderr)
        assert fail.returncode == 7 and b'exit 7' in fail.stderr and b'Check passed.' not in fail.stdout
        result['failure_case'] = {'exit': fail.returncode}
        result['status'] = 'passed'
    except BaseException as error:
        result['failure_type'] = type(error).__name__
        result['failure'] = str(error)
    finally:
        if proc.poll() is None:
            proc.terminate()
            try: proc.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill(); proc.communicate(timeout=3)
        (out/'result.json').write_text(json.dumps(result, indent=2, sort_keys=True)+'\n')
    print(json.dumps({'status':result['status'], 'evidence':str(out)}))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
