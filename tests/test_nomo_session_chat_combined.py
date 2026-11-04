"""Combined launcher/registry/PTY tests with synthetic read and work backends."""
import json,os,pty,re,select,shlex,shutil,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
READ='''import json,sys\nfrom pathlib import Path\na=sys.argv[1:];state=Path(a[a.index('--state')+1]);policy=a[a.index('--events-policy-dir')+1] if '--events-policy-dir' in a else None\nwith (state/'synthetic.jsonl').open('a') as f:f.write(json.dumps({'mode':a[0],'policy':policy,'outputs':'--outputs' in a})+'\\n')\nprint('SYNTHETIC READ '+a[0],flush=True)\n'''
WORK='''import json,sys\nfrom pathlib import Path\na=sys.argv[1:];state=Path(a[a.index('--state')+1]);policy=a[a.index('--events-policy-dir')+1] if '--events-policy-dir' in a else None\nwith (state/'synthetic.jsonl').open('a') as f:f.write(json.dumps({'mode':'work','policy':policy,'outputs':False})+'\\n')\nprint('SYNTHETIC WORK',flush=True)\n'''
class CombinedTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.scripts=self.root/'scripts';self.scripts.mkdir();self.sessions=self.root/'session dir';self.sessions.mkdir(mode=0o700);self.workspace=self.root/'work dir';self.workspace.mkdir(mode=0o700);self.policy=self.root/'policy dir';self.policy.mkdir(mode=0o700)
  for name in ('nomo-read.sh','nomo-session-chat.py','nomo-session-id.py','nomo-edit.py'):shutil.copy2(ROOT/'scripts'/name,self.scripts/name)
  (self.scripts/'nomo-read-session.py').write_text(READ);(self.scripts/'nomo-history-work.py').write_text(WORK)
  self.base=['bash',str(self.scripts/'nomo-read.sh'),'session-chat','--sessions-dir',str(self.sessions),'--root',str(self.workspace),'--allow','file.txt']
 def interactive(self,events):
  args=self.base+['--new']+(['--events-policy-dir',str(self.policy)] if events else [])
  master,slave=pty.openpty();p=subprocess.Popen(args,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);data=bytearray()
  def wait(needle,start=0):
   end=time.monotonic()+6
   while needle not in data[start:] and time.monotonic()<end:
    if select.select([master],[],[],.1)[0]:
     try:data.extend(os.read(master,65536))
     except OSError:break
   self.assertIn(needle,data[start:])
  try:
   wait(b'nomo> ');start=len(data);os.write(master,b'first question\n');wait(b'SYNTHETIC READ new',start);wait(b'Resume interactive:',start);wait(b'nomo> ',start)
   ids=re.findall(rb'^SESSION ID ([0-9a-f]{32})\r?$',bytes(data),re.M);self.assertEqual(1,len(ids));identifier=ids[0].decode()
   line=next(x.decode().removeprefix('Resume interactive: ') for x in bytes(data).splitlines() if x.startswith(b'Resume interactive: '));resume=shlex.split(line)
   start=len(data);os.write(master,b'/outputs\n')
   wait(b'REFUSED /outputs is unavailable' if events else b'SYNTHETIC READ status',start);wait(b'nomo> ',start)
   start=len(data);work='/work op '+shlex.quote(str(self.workspace))+' file.txt task\n';os.write(master,work.encode())
   wait(b'SYNTHETIC WORK',start);wait(b'nomo> ',start)
   start=len(data);os.write(master,b'/status\n');wait(b'SYNTHETIC READ status',start);wait(b'nomo> ',start);os.write(master,b'/exit\n');self.assertEqual(0,p.wait(timeout=5))
   if events:self.assertIn('--events-policy-dir='+str(self.policy),resume)
   else:self.assertFalse(any(x.startswith('--events-policy-dir=') for x in resume))
   again=subprocess.run(resume+['--once','next'],input=b'',stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=6);self.assertEqual(0,again.returncode,again.stderr)
   records=[json.loads(x) for x in (self.sessions/identifier/'synthetic.jsonl').read_text().splitlines()]
   if events:self.assertEqual([{'mode':'new','policy':str(self.policy),'outputs':False},{'mode':'work','policy':str(self.policy),'outputs':False},{'mode':'status','policy':str(self.policy),'outputs':False},{'mode':'continue','policy':str(self.policy),'outputs':False}],records)
   else:self.assertEqual([{'mode':'new','policy':None,'outputs':False},{'mode':'status','policy':None,'outputs':True},{'mode':'work','policy':None,'outputs':False},{'mode':'status','policy':None,'outputs':False},{'mode':'continue','policy':None,'outputs':False}],records)
  finally:
   if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2)
   os.close(master)
 def test_new_default_preserves_outputs_and_work(self):self.interactive(False)
 def test_new_event_mode_preserves_policy_for_work_and_status(self):self.interactive(True)
 def test_piped_new_event_mode_keeps_policy(self):
  p=subprocess.run(self.base+['--new','--events-policy-dir',str(self.policy)],input=b'one question\n',stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=6)
  self.assertEqual(0,p.returncode,p.stderr);ids=re.findall(rb'^SESSION ID ([0-9a-f]{32})$',p.stdout,re.M);self.assertEqual(1,len(ids));events=(self.sessions/ids[0].decode()/'synthetic.jsonl').read_text().splitlines();self.assertEqual(str(self.policy),json.loads(events[0])['policy'])
 def test_piped_invalid_input_does_not_create_a_session(self):
  for payload in (b'first\nsecond\n', b'x'*513+b'\n', b'a\x00b\n', 'x\u202ey\n'.encode()):
   p=subprocess.run(self.base+['--new'],input=payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=6)
   self.assertEqual(64,p.returncode,p.stderr);self.assertFalse(list(self.sessions.iterdir()))
if __name__=='__main__':unittest.main()
