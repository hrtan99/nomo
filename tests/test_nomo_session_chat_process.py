"""Real launcher/process/PTY wiring; the session backend is a synthetic stub."""
import json,os,pty,select,shutil,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
STUB='''import json,os,sys\ndata=sys.stdin.buffer.read()\nwith open(os.environ['NOMO_TEST_RECORD'],'w') as f: json.dump({'args':sys.argv[1:],'stdin_bytes':len(data)},f)\nprint('SYNTHETIC RESUME COMPLETED',flush=True)\n'''
class ProcessTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);scripts=self.root/'scripts';scripts.mkdir()
  for name in ('nomo-read.sh','nomo-session-chat.py','nomo-edit.py'):shutil.copy2(ROOT/'scripts'/name,scripts/name)
  (scripts/'nomo-session-id.py').write_text(STUB);self.record=self.root/'result.json';self.env=dict(os.environ,NOMO_TEST_RECORD=str(self.record))
  self.cmd=['bash',str(scripts/'nomo-read.sh'),'session-chat','--sessions-dir','/tmp/session folder','--id','1'*32,'--root','/tmp/workspace','--allow','file.txt']
 def run_pipe(self,data,*extra):
  return subprocess.run(self.cmd+list(extra),input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env,timeout=5)
 def test_pipe_one_line_and_eof_run_one_read_only_turn(self):
  p=self.run_pipe('提问 test\r\n'.encode());self.assertEqual(0,p.returncode,p.stderr);rec=json.loads(self.record.read_text());self.assertIn('--once=提问 test',rec['args']);self.assertEqual(0,rec['stdin_bytes']);self.assertIn(b'SYNTHETIC RESUME COMPLETED',p.stdout)
 def test_empty_extra_lines_invalid_utf8_and_too_long_refused(self):
  for raw in (b'',b'\n',b'  \n',b'one\ntwo\n',b'one\n\n',b'\xff\n',b'a'*129+b'\n','é'.encode()*65+b'\n',b'a\rb\n',b'a\x00b\n'):
   with self.subTest(raw=raw):
    p=self.run_pipe(raw);self.assertEqual(64,p.returncode);self.assertIn(b'REFUSED',p.stderr);self.assertFalse(self.record.exists())
 def test_exact_limit_and_no_newline(self):
  p=self.run_pipe(b'a'*128);self.assertEqual(0,p.returncode);self.assertEqual(0,json.loads(self.record.read_text())['stdin_bytes'])
 def test_missing_eof_times_out_and_never_dispatches(self):
  p=subprocess.Popen(self.cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env)
  try:
   p.stdin.write(b'one\n');p.stdin.flush();self.assertEqual(64,p.wait(timeout=5));self.assertIn(b'EOF',p.stderr.read());self.assertFalse(self.record.exists())
  finally:
   if p.poll() is None:p.kill();p.wait(timeout=2)
   p.stdin.close();p.stdout.close();p.stderr.close()
 def test_explicit_once_with_piped_extra_never_forwards_stdin(self):
  p=self.run_pipe(b'extra\n','--once','explicit');self.assertEqual(0,p.returncode,p.stderr);result=json.loads(self.record.read_text());self.assertIn('--once=explicit',result['args']);self.assertEqual(0,result['stdin_bytes'])
 def test_interrupt_while_waiting_for_pipe_eof_stops_without_dispatch(self):
  p=subprocess.Popen(self.cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env,start_new_session=True)
  try:
   p.stdin.write(b'one\n');p.stdin.flush();time.sleep(.25);os.killpg(p.pid,signal.SIGINT)
   self.assertEqual(130,p.wait(timeout=4));self.assertFalse(self.record.exists())
  finally:
   if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2)
   p.stdin.close();p.stdout.close();p.stderr.close()
 def test_interrupt_at_tty_prompt_stops_without_dispatch(self):
  master,slave=pty.openpty();p=subprocess.Popen(self.cmd,stdin=slave,stdout=slave,stderr=slave,env=self.env,start_new_session=True);os.close(slave);data=bytearray()
  try:
   until=time.monotonic()+4
   while b'nomo> ' not in data and time.monotonic()<until:
    if select.select([master],[],[],.1)[0]:data.extend(os.read(master,4096))
   self.assertIn(b'nomo> ',data);os.killpg(p.pid,signal.SIGINT);self.assertEqual(130,p.wait(timeout=4));self.assertFalse(self.record.exists())
  finally:
   if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2)
   os.close(master)
 def test_tty_help_and_eof_remain_interactive(self):
  master,slave=pty.openpty();p=subprocess.Popen(self.cmd,stdin=slave,stdout=slave,stderr=slave,env=self.env,start_new_session=True);os.close(slave);data=bytearray()
  try:
   until=time.monotonic()+4
   while b'nomo> ' not in data and time.monotonic()<until:
    if select.select([master],[],[],.1)[0]:data.extend(os.read(master,4096))
   self.assertIn(b'nomo> ',data);os.write(master,b'/help\n');until=time.monotonic()+4
   while b'Quote arguments containing spaces.' not in data and time.monotonic()<until:
    if select.select([master],[],[],.1)[0]:data.extend(os.read(master,4096))
   self.assertIn(b'Quote arguments containing spaces.',data);os.write(master,b'\x04');self.assertEqual(0,p.wait(timeout=4));self.assertFalse(self.record.exists())
  finally:
   if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2)
   os.close(master)
 def test_terminal_stdin_redirected_stdout_requires_explicit_once(self):
  master,slave=pty.openpty()
  try:
   p=subprocess.run(self.cmd,stdin=slave,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env,timeout=4);self.assertEqual(64,p.returncode);self.assertIn(b'redirected output',p.stderr);self.assertFalse(self.record.exists())
  finally:os.close(slave);os.close(master)
if __name__=='__main__':unittest.main()
