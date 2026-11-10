"""Real shell, terminal loop, process ownership and ID registry; synthetic backends."""
import json,os,pty,re,select,shlex,shutil,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
BACKEND='''import json,os,sys\nfrom pathlib import Path\na=sys.argv[1:];state=Path(a[a.index('--state')+1]);action=a[0]\nwith (state/'synthetic-events.jsonl').open('a') as f:f.write(json.dumps({'kind':'read','mode':action})+'\\n')\nif os.environ.get('NOMO_FAIL_FIRST')=='1' and action=='new':sys.exit(9)\nprint('SYNTHETIC READ '+action,flush=True)\n'''
WORK='''import json,sys\nfrom pathlib import Path\na=sys.argv[1:];state=Path(a[a.index('--state')+1])\nwith (state/'synthetic-events.jsonl').open('a') as f:f.write(json.dumps({'kind':'work','check_given':'--check' in a})+'\\n')\nprint('SYNTHETIC WORK',flush=True)\n'''

class NewChatProcessTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.scripts=self.root/'scripts';self.scripts.mkdir();self.sessions=self.root/'session dir';self.sessions.mkdir(mode=0o700);self.workspace=self.root/'work dir';self.workspace.mkdir(mode=0o700)
  for name in ('nomo-read.sh','nomo-session-chat.py','nomo-session-id.py','nomo-edit.py','nomo_terminal.py'):shutil.copy2(ROOT/'scripts'/name,self.scripts/name)
  (self.scripts/'nomo-read-session.py').write_text(BACKEND);(self.scripts/'nomo-history-work.py').write_text(WORK)
  self.base=['bash',str(self.scripts/'nomo-read.sh'),'session-chat','--sessions-dir',str(self.sessions),'--root',str(self.workspace),'--allow','file.txt'];self.env=dict(os.environ,NOMO_LOG_FORMAT='raw')
 def test_new_read_work_exit_then_separate_process_resume(self):
  master,slave=pty.openpty();p=subprocess.Popen(self.base+['--new'],stdin=slave,stdout=slave,stderr=slave,env=self.env,start_new_session=True);os.close(slave);data=bytearray()
  def wait(needle,start=0):
   end=time.monotonic()+6
   while needle not in data[start:] and time.monotonic()<end:
    if select.select([master],[],[],.1)[0]:
     try:data.extend(os.read(master,65536))
     except OSError:break
   self.assertIn(needle,data[start:])
  try:
   wait(b'nomo> ');start=len(data);os.write(master,b'/work op /tmp file task\n');wait(b'REFUSED enter a first question',start);self.assertEqual([],list(self.sessions.iterdir()))
   start=len(data);os.write(master,b'first question\n');wait(b'SYNTHETIC READ new',start);wait(b'Resume interactive:',start);wait(b'nomo> ',start)
   matches=re.findall(rb'^SESSION ID ([0-9a-f]{32})\r?$',bytes(data),re.M);self.assertEqual(1,len(matches));identifier=matches[0].decode()
   resume_line=next(x.decode().removeprefix('Resume interactive: ') for x in bytes(data).splitlines() if x.startswith(b'Resume interactive: '));resume=shlex.split(resume_line);self.assertIn('--id='+identifier,resume);self.assertIn('--sessions-dir='+str(self.sessions),resume);self.assertIn('--root='+str(self.workspace),resume)
   start=len(data);work='/work op '+shlex.quote(str(self.workspace))+' file.txt "edit task" --check python3 -m unittest\n';os.write(master,work.encode());wait(b'SYNTHETIC WORK',start);wait(b'nomo> ',start);os.write(master,b'/exit\n');self.assertEqual(0,p.wait(timeout=4))
   after=subprocess.run(self.base+['--id',identifier,'--once','second question'],input=b'',stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env,timeout=6)
   self.assertEqual(0,after.returncode,after.stderr);self.assertIn(b'SYNTHETIC READ continue',after.stdout)
   events=[json.loads(x) for x in (self.sessions/identifier/'synthetic-events.jsonl').read_text().splitlines()]
   self.assertEqual([{'kind':'read','mode':'new'},{'kind':'work','check_given':True},{'kind':'read','mode':'continue'}],events)
  finally:
   if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2)
   os.close(master)
 def test_new_piped_one_shot_creates_exactly_one_session(self):
  p=subprocess.run(self.base+['--new'],input='提问\n'.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env,timeout=6)
  self.assertEqual(0,p.returncode,p.stderr);ids=re.findall(rb'^SESSION ID ([0-9a-f]{32})$',p.stdout,re.M);self.assertEqual(1,len(ids));self.assertIn(b'Resume interactive:',p.stdout)
  events=(self.sessions/ids[0].decode()/'synthetic-events.jsonl').read_text().splitlines();self.assertEqual(1,len(events))
 def test_eof_before_first_question_creates_nothing(self):
  master,slave=pty.openpty();p=subprocess.Popen(self.base+['--new'],stdin=slave,stdout=slave,stderr=slave,env=self.env,start_new_session=True);os.close(slave);data=bytearray()
  try:
   end=time.monotonic()+4
   while b'nomo> ' not in data and time.monotonic()<end:
    if select.select([master],[],[],.1)[0]:data.extend(os.read(master,4096))
   self.assertIn(b'nomo> ',data);os.write(master,b'\x04');self.assertEqual(0,p.wait(timeout=4));self.assertEqual([],list(self.sessions.iterdir()));self.assertNotIn(b'SESSION ID ',data)
  finally:
   if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2)
   os.close(master)
 def test_invalid_registry_never_prints_fake_id_or_starts_backend(self):
  bad=list(self.base);bad[bad.index('--sessions-dir')+1]=str(self.root/'missing')
  p=subprocess.run(bad+['--new','--once','first'],input=b'',stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env,timeout=6)
  self.assertNotEqual(0,p.returncode);self.assertNotIn(b'SESSION ID ',p.stdout);self.assertNotIn(b'Resume interactive:',p.stdout);self.assertEqual([],list(self.sessions.iterdir()))
 def test_failed_first_read_retains_actual_id_without_retry(self):
  env=dict(self.env,NOMO_FAIL_FIRST='1');p=subprocess.run(self.base+['--new','--once','first'],input=b'',stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=6)
  self.assertEqual(9,p.returncode);ids=re.findall(rb'^SESSION ID ([0-9a-f]{32})$',p.stdout,re.M);self.assertEqual(1,len(ids));self.assertNotIn(b'Resume interactive:',p.stdout)
  events=(self.sessions/ids[0].decode()/'synthetic-events.jsonl').read_text().splitlines();self.assertEqual(1,len(events))
 def test_new_and_id_are_mutually_exclusive(self):
  p=subprocess.run(self.base+['--new','--id','1'*32,'--once','first'],input=b'',stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env,timeout=6)
  self.assertEqual(2,p.returncode);self.assertEqual([],list(self.sessions.iterdir()))
if __name__=='__main__':unittest.main()
