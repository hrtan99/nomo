#!/usr/bin/env python3
"""Recording doubles with real PTY descriptors; no Docker, Etas, fixture or Provider."""
import ast
import json
import os
import pty
import termios
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent
LAUNCH = ROOT / 'scripts/local-tryout.sh'
HELPER = ROOT / 'scripts/terminal-transport.py'
TOKEN = 'terminal-transport-synthetic-key'
DOCKER_DOUBLE = r'''import hashlib,json,os,signal,sys,time
from pathlib import Path
args=sys.argv[1:]
record_path=Path(os.environ['NOMO_TERMINAL_TEST_DOCKER'])
state_path=Path(os.environ['NOMO_TERMINAL_TEST_CONTAINER'])
events_path=Path(os.environ['NOMO_TERMINAL_TEST_EVENTS'])
def write(path,value):
    temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(value));temporary.replace(path)
def event(value):
    with events_path.open('a') as output:output.write(json.dumps(value)+'\n')
def state():
    return json.loads(state_path.read_text()) if state_path.exists() else {'exists':False}
if args and args[0]=='compose':
    assert 'run' in args and 'dev' in args
    prefixes=('ETAS_HOST_MODEL','ETAS_HOST_OMLX','NOMO_QWEN','NOMO_GATEWAY')
    record={'argv':args,'model_env_keys':sorted(k for k in os.environ if k.startswith(prefixes)),
            'host_approval':os.environ.get('ETAS_HOST_APPROVAL'),'stdin':[],
            'state':os.environ.get('NOMO_EDIT_STATE_DIR'),'workspace':os.environ.get('NOMO_EDIT_WORKSPACE_DIR'),
            'context':os.environ.get('NOMO_WORK_CONTEXT_DIR'),'client_pid':os.getpid()}
    owned='--name' in args
    if owned:
        name=args[args.index('--name')+1];label=args[args.index('--label')+1]
        assert label.startswith('nomo.terminal.invocation=')
        owner=label.split('=',1)[1];identifier=hashlib.sha256(owner.encode()).hexdigest()
        record.update(name=name,owner=owner,container_id=identifier)
        pending=os.environ.get('NOMO_TERMINAL_TEST_LATE_CREATE') or os.environ.get('NOMO_TERMINAL_TEST_NO_CREATE')
        write(state_path,{'exists':not pending,'id':identifier,'name':'/'+name,
                         'owner':'someone-else' if os.environ.get('NOMO_TERMINAL_TEST_FOREIGN') else owner})
    write(record_path,record);event({'kind':'run','owned':owned})
    if os.environ.get('NOMO_TERMINAL_TEST_WAIT'):
        def interrupted(number,_frame):
            event({'kind':'signal','signal':number,'at':time.monotonic()})
            if not os.environ.get('NOMO_TERMINAL_TEST_IGNORE'):raise SystemExit(128+number)
        signal.signal(signal.SIGINT,interrupted);signal.signal(signal.SIGTERM,interrupted)
        Path(os.environ['NOMO_TERMINAL_TEST_READY']).write_text('ready')
        while True:time.sleep(.05)
    record['stdin']=list(sys.stdin.buffer.read());write(record_path,record)
    if owned and not os.environ.get('NOMO_TERMINAL_TEST_RETAIN'):
        value=state();value['exists']=False;write(state_path,value)
    raise SystemExit(int(os.environ.get('NOMO_TERMINAL_TEST_EXIT','0')))
if args and args[0]=='inspect':
    value=state();target=args[-1];event({'kind':'inspect','target':target})
    if os.environ.get('NOMO_TERMINAL_TEST_CLEANUP_INSPECT'):
        history=list(map(json.loads,events_path.read_text().splitlines()))
        marker=Path(os.environ['NOMO_TERMINAL_TEST_CLEANUP_INSPECT'])
        if any(item['kind']=='signal' for item in history) and not marker.exists():
            marker.write_text(str(os.getpid()))
            time.sleep(.8)
    if not value['exists'] or target not in (value['id'],value['name'].lstrip('/')):
        # Simulate a daemon-side create committing just after this missing response.
        # The earlier helper inspected while its creator was live, then killed it
        # without another lookup and leaked this exact owned container.
        history=list(map(json.loads,events_path.read_text().splitlines()))
        signals=[item for item in history if item['kind']=='signal']
        if not value['exists'] and os.environ.get('NOMO_TERMINAL_TEST_LATE_CREATE') and signals and time.monotonic()-signals[0]['at']>=1.5 and not any(item['kind']=='late-create' for item in history):
            record=json.loads(record_path.read_text())
            try:os.kill(record['client_pid'],0);creator_alive=True
            except ProcessLookupError:creator_alive=False
            value['exists']=True;write(state_path,value)
            event({'kind':'late-create','creator_alive':creator_alive})
        print('Error: No such object: '+target,file=sys.stderr);raise SystemExit(1)
    print(value['id']+'\n'+value['name']+'\n'+value['owner']);raise SystemExit(0)
if args and args[0] in ('stop','rm'):
    value=state();event({'kind':args[0],'target':args[-1]})
    assert value['exists'] and args[-1]==value['id']
    if args[0]=='rm':value['exists']=False
    write(state_path,value);raise SystemExit(0)
raise SystemExit('unexpected fake Docker command')
'''


class TerminalTransportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nomo-terminal-transport-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.fixture = self.directory / 'never-created-tryout'
        self.docker_record = self.directory / 'docker.json'
        self.preflight_record = self.directory / 'preflight.json'
        self.container = self.directory / 'container.json'
        self.events = self.directory / 'events.jsonl'
        self.ready = self.directory / 'ready'
        binary = self.directory / 'bin'
        binary.mkdir()
        preflight = '''import json,os,sys
from pathlib import Path
if Path(sys.argv[1]).resolve()==Path(HELPER_PATH):
    os.execv(sys.executable,[sys.executable,*sys.argv[1:]])
assert len(sys.argv)==5 and Path(sys.argv[1]).name=='prepare-local-tryout.py' and sys.argv[2:4]==['--check','--']
Path(os.environ['NOMO_TERMINAL_TEST_PREFLIGHT']).write_text(json.dumps(sys.argv[1:]))
print(sys.argv[4])
'''.replace('HELPER_PATH', repr(str(HELPER)))
        self.stub(binary / 'python3', preflight)
        self.stub(binary / 'docker', DOCKER_DOUBLE)
        self.environment = {'PATH':str(binary)+os.pathsep+os.defpath,
                            'PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1',
                            'NOMO_TERMINAL_TEST_DOCKER':str(self.docker_record),
                            'NOMO_TERMINAL_TEST_PREFLIGHT':str(self.preflight_record),
                            'NOMO_TERMINAL_TEST_CONTAINER':str(self.container),
                            'NOMO_TERMINAL_TEST_EVENTS':str(self.events),
                            'NOMO_TERMINAL_TEST_READY':str(self.ready)}
        self.arguments = ['new','--id','root-op','--child-id','child-op','--workspace','owned',
                          '--path','target.txt','--once','replace selected','--allow','context.txt']

    def stub(self, path, body):
        ast.parse(body)
        path.write_text('#!'+sys.executable+'\n'+body)
        path.chmod(0o700)

    def environment_with(self, overrides):
        value=dict(self.environment);value.update(overrides);return value

    def launch(self, *arguments, data=b'', **overrides):
        result=subprocess.run([str(LAUNCH),*map(str,arguments)],cwd=ROOT,
                              env=self.environment_with(overrides),input=data,capture_output=True,timeout=20)
        self.assertFalse(self.fixture.exists(),'recording tests must not provision work fixtures')
        return result

    def recorded_events(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()]

    def assert_owned_cleanup(self):
        record=json.loads(self.docker_record.read_text())
        changed=[event for event in self.recorded_events() if event['kind'] in ('stop','rm')]
        self.assertEqual([event['kind'] for event in changed],['stop','rm'])
        self.assertTrue(all(event['target']==record['container_id'] for event in changed))
        self.assertFalse(json.loads(self.container.read_text())['exists'])

    def test_non_tty_terminal_selects_once_deny_and_preserves_pipe(self):
        arguments=list(self.arguments);arguments[arguments.index('--once')+1]="literal $(never-execute) 'quoted'"
        data=b'y\nsecond request must remain input data\n'
        observed=self.launch('terminal',self.fixture,*arguments,data=data,
                             ETAS_HOST_APPROVAL='auto',NOMO_QWEN_SERVER_API_KEY=TOKEN)
        self.assertEqual(observed.returncode,0,observed.stderr.decode())
        record=json.loads(self.docker_record.read_text());argv=record['argv']
        self.assertIn('--tty=false',argv);self.assertNotIn('--tty=true',argv)
        self.assertIn('ETAS_HOST_APPROVAL=deny',argv);self.assertNotIn('ETAS_HOST_APPROVAL=auto',argv)
        self.assertEqual(argv[argv.index('ETAS_HOST_APPROVAL=deny')-1],'-e')
        self.assertEqual(record['host_approval'],'auto')
        self.assertEqual(record['stdin'],list(data),'transport must not consume or inject consent')
        self.assertEqual(argv[argv.index('--flow')+1],'terminal_once')
        self.assertEqual(argv[argv.index('--profile')+1],'work-chain-once')
        self.assertEqual(argv[argv.index('--args')+1:],arguments)
        self.assertEqual(json.loads(self.preflight_record.read_text()),
                         [str(ROOT/'scripts/prepare-local-tryout.py'),'--check','--',str(self.fixture)])
        self.assertEqual(record['state'],str(self.fixture/'state'))
        self.assertEqual(record['workspace'],str(self.fixture/'workspace'))
        self.assertEqual(record['context'],str(self.fixture/'context'))
        self.assertIn(str(ROOT/'config/local-tryout-model-compose.yaml'),argv)
        self.assertTrue(record['name'].startswith('nomo-terminal-'))
        self.assertIn('nomo.terminal.invocation='+record['owner'],argv)

    def test_terminal_mixed_and_tty_descriptors_select_expected_mode(self):
        for stdin_tty, stdout_tty in ((True, False), (False, True), (True, True)):
            with self.subTest(stdin_tty=stdin_tty, stdout_tty=stdout_tty):
                master, slave = pty.openpty()
                settings = termios.tcgetattr(slave)
                settings[3] &= ~(termios.ECHO | termios.ECHONL)
                termios.tcsetattr(slave, termios.TCSANOW, settings)
                process = None
                try:
                    process = subprocess.Popen(
                        [str(LAUNCH), 'terminal', str(self.fixture), *self.arguments],
                        cwd=ROOT, env=self.environment_with({}),
                        stdin=slave if stdin_tty else subprocess.PIPE,
                        stdout=slave if stdout_tty else subprocess.PIPE,
                        stderr=subprocess.PIPE, start_new_session=True)
                    os.close(slave); slave = -1
                    if stdin_tty:
                        os.write(master, b'\x04')
                    out, err = process.communicate(input=None if stdin_tty else b'', timeout=20)
                    self.assertEqual(process.returncode, 0, (out, err))
                    record = json.loads(self.docker_record.read_text())
                    argv = record['argv']; interactive = stdin_tty and stdout_tty
                    self.assertIn('--tty=' + str(interactive).lower(), argv)
                    self.assertIn('ETAS_HOST_APPROVAL=' + ('prompt' if interactive else 'deny'), argv)
                    self.assertEqual(argv[argv.index('--flow') + 1], 'terminal' if interactive else 'terminal_once')
                    self.assertEqual(argv[argv.index('--profile') + 1], 'work-chain' if interactive else 'work-chain-once')
                    self.assertFalse(json.loads(self.container.read_text())['exists'])
                    with self.assertRaises(ProcessLookupError):
                        os.kill(record['client_pid'], 0)
                    self.assertFalse(self.fixture.exists())
                finally:
                    if process is not None and process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=2)
                    if slave >= 0: os.close(slave)
                    os.close(master)

    def test_terminal_help_is_provider_free_readonly_without_fixture(self):
        observed=self.launch('terminal-help',ETAS_HOST_APPROVAL='auto',
                             ETAS_HOST_MODEL_BASE_URL='http://invalid.test',ETAS_HOST_MODEL_API_KEY=TOKEN,
                             ETAS_HOST_OMLX_API_KEY=TOKEN,NOMO_QWEN_SERVER_API_KEY=TOKEN,NOMO_GATEWAY_CLIENT_TOKEN=TOKEN)
        self.assertEqual(observed.returncode,0,observed.stderr.decode());self.assertFalse(self.preflight_record.exists())
        record=json.loads(self.docker_record.read_text());argv=record['argv']
        self.assertEqual(record['model_env_keys'],[]);self.assertIsNone(record['state'])
        self.assertIn('--tty=false',argv);self.assertIn('ETAS_HOST_APPROVAL=deny',argv)
        self.assertEqual(argv[argv.index('--flow')+1],'terminal_help')
        self.assertEqual(argv[argv.index('--profile')+1],'chain-help')
        self.assertNotIn('--name',argv)
        overlays=[argv[i+1] for i,value in enumerate(argv[:-1]) if value=='--file']
        self.assertEqual(overlays[-1],str(ROOT/'config/local-tryout-readonly-compose.yaml'))
        self.assertNotIn(str(ROOT/'config/local-tryout-model-compose.yaml'),overlays)
        self.assertIn('ETAS_HOST_APPROVAL: "deny"',(ROOT/'config/local-tryout-readonly-compose.yaml').read_text())

    def test_missing_directory_refuses_before_preflight_or_client(self):
        observed=self.launch('terminal');self.assertEqual(observed.returncode,64)
        self.assertFalse(self.preflight_record.exists());self.assertFalse(self.docker_record.exists())

    def test_help_preserves_client_failure_status(self):
        observed=self.launch('terminal-help',NOMO_TERMINAL_TEST_EXIT='37')
        self.assertEqual(observed.returncode,37);self.assertFalse(self.preflight_record.exists())

    def test_owned_completed_client_releases_only_its_exact_container(self):
        observed=self.launch('terminal',self.fixture,*self.arguments,NOMO_TERMINAL_TEST_RETAIN='1')
        self.assertEqual(observed.returncode,0,observed.stderr.decode());self.assert_owned_cleanup()

    def test_foreign_ownership_is_never_stopped_or_removed(self):
        observed=self.launch('terminal',self.fixture,*self.arguments,NOMO_TERMINAL_TEST_RETAIN='1',
                             NOMO_TERMINAL_TEST_FOREIGN='1',NOMO_TERMINAL_TEST_EXIT='37')
        self.assertEqual(observed.returncode,37,observed.stderr.decode())
        self.assertTrue(json.loads(self.container.read_text())['exists'])
        self.assertFalse(any(event['kind'] in ('stop','rm') for event in self.recorded_events()))

    def cancellation(self, number, ignore=False, expected=None, **extra):
        overrides={'NOMO_TERMINAL_TEST_WAIT':'1','NOMO_TERMINAL_TEST_RETAIN':'1'}
        overrides.update(extra)
        if ignore:overrides['NOMO_TERMINAL_TEST_IGNORE']='1'
        if expected is None:expected=128+number
        process=subprocess.Popen([str(LAUNCH),'terminal',str(self.fixture),*self.arguments],cwd=ROOT,
                                 env=self.environment_with(overrides),stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        process.stdin.close();process.stdin=None
        try:
            deadline=time.monotonic()+5
            while not self.ready.exists():
                self.assertIsNone(process.poll(),'recording client exited before ready')
                self.assertLess(time.monotonic(),deadline,'recording client startup deadline')
                time.sleep(.02)
            started=time.monotonic();os.kill(process.pid,number)
            out,err=process.communicate(timeout=15)
            self.assertEqual(process.returncode,expected,(out,err))
            self.assertLess(time.monotonic()-started,14)
            if expected==125:
                self.assertIn(b'unconfirmed',err)
                self.assertFalse(json.loads(self.container.read_text())['exists'])
                self.assertFalse(any(event['kind'] in ('stop','rm') for event in self.recorded_events()))
            else:self.assert_owned_cleanup()
            events=self.recorded_events()
            signals=[event['signal'] for event in events if event['kind']=='signal']
            self.assertEqual(signals,[number],'only one INT/TERM must be forwarded')
            self.assertFalse(self.fixture.exists())
            return events
        finally:
            if self.docker_record.exists():
                client=json.loads(self.docker_record.read_text()).get('client_pid')
                if client is not None:
                    try:os.killpg(client,signal.SIGKILL)
                    except ProcessLookupError:pass
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=2)

    def test_SIGINT_forwards_once_then_cleans_owned_work(self):
        self.cancellation(signal.SIGINT)

    def test_SIGTERM_forwards_once_then_cleans_owned_work(self):
        self.cancellation(signal.SIGTERM)

    def test_repeated_group_signal_does_not_interrupt_cleanup_inspection(self):
        marker = self.directory / 'cleanup-inspect-ready'
        env = self.environment_with({'NOMO_TERMINAL_TEST_WAIT':'1',
                                     'NOMO_TERMINAL_TEST_RETAIN':'1',
                                     'NOMO_TERMINAL_TEST_CLEANUP_INSPECT':str(marker)})
        process = subprocess.Popen([str(LAUNCH),'terminal',str(self.fixture),*self.arguments],cwd=ROOT,
                                   env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE,start_new_session=True)
        try:
            deadline = time.monotonic() + 8
            while not self.ready.exists() or not any(e['kind']=='inspect' for e in self.recorded_events()):
                self.assertIsNone(process.poll())
                self.assertLess(time.monotonic(),deadline)
                time.sleep(.02)
            os.kill(process.pid,signal.SIGTERM)
            while not marker.exists():
                self.assertIsNone(process.poll())
                self.assertLess(time.monotonic(),deadline)
                time.sleep(.02)
            os.killpg(process.pid,signal.SIGTERM)
            out,err=process.communicate(timeout=15)
            self.assertEqual(process.returncode,143,(out,err))
            self.assert_owned_cleanup()
        finally:
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGKILL)
                process.wait(timeout=3)

    def test_timed_out_cleanup_inspection_is_killed_and_reaped(self):
        marker = self.directory / 'cleanup-inspect-ready'
        env = self.environment_with({'NOMO_TERMINAL_TEST_WAIT':'1',
                                     'NOMO_TERMINAL_TEST_RETAIN':'1',
                                     'NOMO_TERMINAL_TEST_CLEANUP_INSPECT':str(marker)})
        driver = '''import importlib.util,sys
s=importlib.util.spec_from_file_location('transport',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.OP_TIMEOUT=.2
raise SystemExit(m.main(['docker','compose','--file','unused','run','dev']))
'''
        process = subprocess.Popen([sys.executable,'-B','-c',driver,str(HELPER)],cwd=ROOT,env=env,
                                   stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                   start_new_session=True)
        try:
            deadline = time.monotonic() + 8
            while not self.ready.exists() or not any(e['kind']=='inspect' for e in self.recorded_events()):
                self.assertIsNone(process.poll())
                self.assertLess(time.monotonic(),deadline)
                time.sleep(.02)
            os.kill(process.pid,signal.SIGTERM)
            out,err=process.communicate(timeout=15)
            self.assertEqual(process.returncode,125,(out,err))
            self.assertTrue(marker.exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(int(marker.read_text()),0)
            self.assertTrue(json.loads(self.container.read_text())['exists'])
            self.assertFalse(any(e['kind'] in ('stop','rm') for e in self.recorded_events()))
        finally:
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGKILL)
                process.wait(timeout=3)

    def test_unresponsive_recording_client_is_bounded_and_reaped(self):
        self.cancellation(signal.SIGTERM,ignore=True)

    def test_late_create_after_missing_is_reconciled_after_creator_reaped(self):
        events=self.cancellation(signal.SIGTERM,ignore=True,NOMO_TERMINAL_TEST_LATE_CREATE='1')
        late=[event for event in events if event['kind']=='late-create']
        self.assertEqual(len(late),1)
        self.assertFalse(late[0]['creator_alive'],'final container reconciliation must follow creator reap')

    def test_startup_cancellation_without_observed_creation_is_unproven(self):
        self.cancellation(signal.SIGINT,expected=125,NOMO_TERMINAL_TEST_NO_CREATE='1')


if __name__=='__main__':
    unittest.main()
