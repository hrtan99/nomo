import importlib.util,unittest
from pathlib import Path
p=Path(__file__).resolve().parent.parent/'scripts/nomo-session-chat.py';s=importlib.util.spec_from_file_location('chat',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class ObserverTests(unittest.TestCase):
 def test_accepts_fragmented_first_line_only(self):
  observer=m.StartIdObserver();observer.feed('stderr',b'SESSION ID '+b'f'*32+b'\n');observer.feed('stdout',b'SESSION ');observer.feed('stdout',b'ID '+b'a'*32+b'\nother\n');self.assertEqual('a'*32,observer.identifier)
  observer.feed('stdout',b'SESSION ID '+b'b'*32+b'\n');self.assertEqual('a'*32,observer.identifier)
 def test_rejects_first_line_malformed_or_oversized(self):
  for first in (b'hello\nSESSION ID '+b'a'*32+b'\n',b'SESSION ID '+b'X'*32+b'\n',b'x'*65):
   observer=m.StartIdObserver();observer.feed('stdout',first);observer.feed('stdout',b'SESSION ID '+b'a'*32+b'\n');self.assertIsNone(observer.identifier)
 def test_incomplete_line_is_never_identifier(self):
  observer=m.StartIdObserver();observer.feed('stdout',b'SESSION ID '+b'a'*32);self.assertIsNone(observer.identifier)
if __name__=='__main__':unittest.main()
