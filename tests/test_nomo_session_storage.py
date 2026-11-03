#!/usr/bin/env python3
"""Private SQLite mode bits without following symlinks or hardlinks."""
import importlib.util,os,stat,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('session_storage',ROOT/'scripts/nomo-session-storage.py');storage=importlib.util.module_from_spec(spec);spec.loader.exec_module(storage)
class SessionStorageTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.state=Path(self.tmp.name)/'state';self.state.mkdir(mode=0o700)
 def test_new_database_created_private_and_not_overwritten(self):
  storage.prepare(self.state,create=True);db=self.state/'history.sqlite3';self.assertEqual(stat.S_IMODE(db.stat().st_mode),0o600);db.write_bytes(b'keep')
  with self.assertRaises(FileExistsError):storage.prepare(self.state,create=True)
  self.assertEqual(db.read_bytes(),b'keep')
 def test_existing_database_and_sidecars_restricted(self):
  for suffix in ('','-wal','-shm','-journal'):
   p=self.state/('history.sqlite3'+suffix);p.write_bytes(b'synthetic');p.chmod(0o644)
  storage.prepare(self.state)
  for suffix in ('','-wal','-shm','-journal'):
   p=self.state/('history.sqlite3'+suffix);self.assertEqual(stat.S_IMODE(p.stat().st_mode),0o600);self.assertEqual(p.read_bytes(),b'synthetic')
 def test_symlink_and_hardlink_refused_without_chmod_target(self):
  outside=Path(self.tmp.name)/'outside';outside.write_bytes(b'keep');outside.chmod(0o644);db=self.state/'history.sqlite3';db.symlink_to(outside)
  with self.assertRaises((OSError,ValueError)):storage.prepare(self.state)
  self.assertEqual(stat.S_IMODE(outside.stat().st_mode),0o644);db.unlink();os.link(outside,db)
  with self.assertRaises(ValueError):storage.prepare(self.state)
  self.assertEqual(stat.S_IMODE(outside.stat().st_mode),0o644);self.assertEqual(outside.read_bytes(),b'keep')
 def test_swapped_entry_refused_before_chmod(self):
  db=self.state/'history.sqlite3';db.write_bytes(b'original');db.chmod(0o644)
  replacement=self.state/'replacement';replacement.write_bytes(b'replacement');replacement.chmod(0o644);old=self.state/'old'
  real_open=os.open;swapped=[]
  def racing_open(path,flags,*args,**kwargs):
   if path=='history.sqlite3' and not swapped:
    os.replace(db,old);os.replace(replacement,db);swapped.append(True)
   return real_open(path,flags,*args,**kwargs)
  with patch.object(storage.os,'open',side_effect=racing_open):
   with self.assertRaises(ValueError):storage.prepare(self.state)
  self.assertTrue(swapped);self.assertEqual(db.read_bytes(),b'replacement');self.assertEqual(stat.S_IMODE(db.stat().st_mode),0o644)
 def test_fifo_refused_before_open(self):
  fifo=self.state/'history.sqlite3';os.mkfifo(fifo,0o600)
  with self.assertRaises(ValueError):storage.prepare(self.state)
  self.assertTrue(stat.S_ISFIFO(fifo.stat().st_mode))
 def test_insecure_directory_and_missing_database_refused(self):
  with self.assertRaises(ValueError):storage.prepare(self.state)
  self.state.chmod(0o755)
  with self.assertRaises(ValueError):storage.prepare(self.state,create=True)
  self.assertFalse((self.state/'history.sqlite3').exists())
if __name__=='__main__':unittest.main()
