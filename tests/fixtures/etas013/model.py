#!/usr/bin/env python3
"""Historical isolated MODEL-001 route using the explicit exact effect rendering."""
import importlib.util
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import traceback
from contextlib import redirect_stdout, redirect_stderr

sys.dont_write_bytecode = True
ROOT = Path('/workspace')
BASE = Path('/validation')


class Tee:
    def __init__(self, stream, log):
        self.stream, self.log = stream, log

    def write(self, text):
        self.log.write(text)
        return self.stream.write(text)

    def flush(self):
        self.log.flush()
        self.stream.flush()


def main():
    project = Path(tempfile.mkdtemp(prefix='model-copy-', dir=BASE))
    shutil.copytree(ROOT / 'src', project / 'src')
    shutil.copytree(ROOT / 'tests/fixtures/model001', project / 'tests/fixtures/model001')
    for name in ['etas.toml', 'etas.lock']:
        shutil.copyfile(ROOT / name, project / name)
    spec = importlib.util.spec_from_file_location('model_probe', ROOT / 'tests/model_probe.py')
    probe = importlib.util.module_from_spec(spec)
    text = (ROOT / 'tests/model_probe.py').read_text()
    assert 'Agentic.infer[nomo.provider.TextModel, string]' in text, 'effect oracle changed; review the adapter'
    (project / 'adapted_model_probe.py').write_text(text)
    # Keep the original __file__ for its existing mock import, then redirect product ROOT.
    exec(compile(text, str(project / 'adapted_model_probe.py'), 'exec'), probe.__dict__)
    probe.ROOT = project
    os.environ['NOMO_NORMAL_GRAPH'] = 'etas0013'
    os.environ['PATH'] = '/validation/target/debug:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    with (project / 'verification.log').open('w') as log:
        with redirect_stdout(Tee(sys.stdout, log)), redirect_stderr(Tee(sys.stderr, log)):
            print('Disposable product copy:', project, flush=True)
            print('Candidate binary SHA256:', hashlib.sha256((BASE / 'target/debug/etas').read_bytes()).hexdigest(), flush=True)
            try:
                probe.main()
            except Exception:
                traceback.print_exc()
                raise


if __name__ == '__main__':
    main()
