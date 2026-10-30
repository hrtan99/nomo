"""010 integrity negative cases using owned synthetic files only."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('bootstrap010',Path(__file__).resolve().parents[1]/'scripts/etas-latest-cli-bootstrap.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)

class IntegrityChecks(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.cache=self.root/'cache';self.lock=self.root/'Cargo.lock'
        arc=self.cache/'registry/cache/index/demo-1.0.0.crate';arc.parent.mkdir(parents=True)
        contents=b'official bytes\n'
        with tarfile.open(arc,'w:gz') as tar:
            entry=tarfile.TarInfo('demo-1.0.0/src/lib.rs');entry.size=len(contents);tar.addfile(entry,io.BytesIO(contents))
        source=self.cache/'registry/src/index/demo-1.0.0/src/lib.rs';source.parent.mkdir(parents=True);source.write_bytes(contents)
        checksum=hashlib.sha256(arc.read_bytes()).hexdigest()
        self.lock.write_text('[[package]]\nname="demo"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="'+checksum+'"\n')
        self.archive=arc;self.source=source
        self.patchers=[patch.object(b,'CACHE',self.cache),patch.object(b,'LOCK',self.lock)]
        for p in self.patchers:p.start();self.addCleanup(p.stop)
    def test_valid_archive_and_extracted_source(self): b.registry_guard()
    def test_modified_archive_refused(self):
        self.archive.write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError,'archive checksum drift'):b.registry_guard()
    def test_modified_extracted_file_refused(self):
        self.source.write_bytes(b'modified')
        with self.assertRaisesRegex(RuntimeError,'extracted registry source drift'):b.registry_guard()
    def test_added_ignored_looking_source_refused(self):
        (self.source.parent/'hidden.rs').write_text('untrusted')
        with self.assertRaisesRegex(RuntimeError,'extracted registry source drift'):b.registry_guard()
    def test_symlinked_registry_source_refused(self):
        self.source.unlink();self.source.symlink_to(self.archive)
        with self.assertRaisesRegex(RuntimeError,'symlinked registry source'):b.registry_guard()
    def test_ignored_git_source_refused(self):
        repo=self.root.resolve()/'repo';repo.mkdir()
        def git(*args):return subprocess.check_output(['git',*args],cwd=repo,text=True).strip()
        git('init','-q');(repo/'.gitignore').write_text('*.local\n');(repo/'source.rs').write_text('ok\n')
        git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture')
        pins={'cli':{'revision':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}')}}
        with patch.object(b,'PINS',pins):
            b.git_guard(repo,'cli')
            (repo/'hidden.local').write_text('unexpected')
            with self.assertRaisesRegex(RuntimeError,'ignored source files'):b.git_guard(repo,'cli')
    def test_adopt_verification_rejects_forged_binary_metadata(self):
        root=self.root/'identity';root.mkdir();installed=root/'etas';installed.write_bytes(b'forged')
        (root/'binary.json').write_text(json.dumps({'path':str(installed),'sha256':b.digest(installed),'version':'etas 0.1.4\n','method':'adopted-independently-verified-010-build','lock_sha256':b.digest(self.lock)}))
        with patch.object(b,'ROOT',root),patch.object(b,'INSTALLED',installed),patch.object(b,'guard'),patch.object(b,'read',return_value='etas 0.1.4\n'):
            with self.assertRaisesRegex(RuntimeError,'not the independently verified 010 build'):b.verify()

if __name__=='__main__':unittest.main()
