#!/usr/bin/env python3
"""Host-side validation and offline-status credential isolation."""
import contextlib,fcntl,importlib.util,io,os,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('read_session_launcher',ROOT/'scripts/nomo-read-session.py');launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)
class Done:returncode=0
class ReadSessionLauncherTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.context=self.root/'context';self.context.mkdir(mode=0o700)
        self.state=self.root/'state';self.state.mkdir(mode=0o700)
        self.project=self.root/'project';self.project.mkdir(mode=0o700);self.root_patch=patch.object(launcher,'ROOT',self.project);self.root_patch.start();self.addCleanup(self.root_patch.stop)
        self.env=patch.dict(os.environ,{'MINIMAX_API_KEY':'SYNTHETIC_KEY','ETAS_HOST_MODEL_API_KEY':'SYNTHETIC_GATEWAY','NOMO_QWEN_SERVER_API_KEY':'SYNTHETIC_QWEN'})
        self.env.start();self.addCleanup(self.env.stop);self.addCleanup(self.tmp.cleanup)
    def invoke(self,args):
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):return launcher.main(args)
    def newargs(self):return ['new','--root',str(self.context),'--state',str(self.state),'--allow','context.txt','--once','read it']
    def existing(self):
        (self.state/'.nomo-session.lock').touch(mode=0o600);(self.state/'history.sqlite3').write_bytes(b'synthetic')
    def test_first_session_creates_private_cache_before_start(self):
        self.assertFalse((self.project/'.etas').exists())
        def owned(command,env,**kwargs):
            cache=self.project/'.etas';self.assertTrue(cache.is_dir());self.assertFalse(cache.is_symlink())
            self.assertEqual(cache.stat().st_mode & 0o777,0o700);return 0
        with patch.object(launcher,'run_owned',side_effect=owned) as run:
            self.assertEqual(self.invoke(self.newargs()),0);run.assert_called_once()
    def test_cache_symlink_refused_before_start(self):
        (self.project/'.etas').symlink_to(self.context,target_is_directory=True)
        with patch.object(launcher,'run_owned') as run:
            self.assertNotEqual(self.invoke(self.newargs()),0);run.assert_not_called()
    def test_cache_regular_file_refused_before_start(self):
        (self.project/'.etas').write_text('not a directory')
        with patch.object(launcher,'run_owned') as run:
            self.assertNotEqual(self.invoke(self.newargs()),0);run.assert_not_called()

    def test_status_removes_model_credentials_and_network_overlay(self):
        self.existing()
        with patch.object(launcher,'run_owned',return_value=0) as run:
            self.assertEqual(self.invoke(['status','--state',str(self.state)]),0)
        cmd=run.call_args.args[0];env=run.call_args.args[1]
        for key in ('MINIMAX_API_KEY','ETAS_HOST_MODEL_API_KEY','NOMO_QWEN_SERVER_API_KEY'):self.assertNotIn(key,env)
        self.assertFalse(any('nomo-minimax-read-compose.yaml' in value for value in cmd));self.assertIn('nomo-read-session-status',cmd)
    def test_026_overlay_and_older_versions_rejected(self):
        self.existing()
        with patch.dict(os.environ, {'NOMO_ETAS_VERSION':'0.2.6'}), patch.object(launcher,'run_owned',return_value=0) as run:
            self.assertEqual(self.invoke(['status','--state',str(self.state)]),0)
            self.assertIn(str(self.project/'config/etas-026-official-compose.yaml'),run.call_args.args[0])
        for version in ('0.2.4','0.2.5'):
            with self.subTest(version=version), patch.dict(os.environ, {'NOMO_ETAS_VERSION':version}), patch.object(launcher,'run_owned') as run:
                self.assertNotEqual(self.invoke(['status','--state',str(self.state)]),0);run.assert_not_called()

    def test_event_policy_routes_read_only_flow_without_exposing_literal_in_arguments(self):
        policy=self.root/'policy';policy.mkdir(mode=0o700);file=policy/'policy.json';file.write_text('{"format":1,"literals":["SYNTHETIC_SECRET"]}');file.chmod(0o600);key=policy/'binding.key';key.write_bytes(b'K'*32);key.chmod(0o600)
        with patch.object(launcher,'run_owned',return_value=0) as run:
            self.assertEqual(self.invoke(self.newargs()+['--events-policy-dir',str(policy)]),0)
        cmd,env=run.call_args.args[:2]
        self.assertIn('recoverable_read_session',cmd);self.assertIn('nomo-read-events-new',cmd)
        self.assertIn('/workspace/scripts/nomo-event-policy-bootstrap.py',cmd)
        self.assertEqual(run.call_args.kwargs['input_data'],file.read_bytes())
        self.assertNotIn('NOMO_EVENT_POLICY_DIR',env)
        self.assertFalse(any('SYNTHETIC_SECRET' in value for value in cmd))

    def test_event_recording_discloses_retained_text_and_limited_filtering(self):
        policy=self.root/'policy';policy.mkdir(mode=0o700);file=policy/'policy.json';file.write_text('{"format":1,"literals":["SYNTHETIC_SECRET"]}');file.chmod(0o600);key=policy/'binding.key';key.write_bytes(b'K'*32);key.chmod(0o600)
        out=io.StringIO()
        with patch.object(launcher,'run_owned',return_value=0),contextlib.redirect_stdout(out),contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(launcher.main(self.newargs()+['--events-policy-dir',str(policy)]),0)
        self.assertIn('Event records retain bounded conversation and tool-result text',out.getvalue())
        self.assertIn('unknown secrets and live terminal output are not comprehensively filtered',out.getvalue())
        self.assertNotIn('event labels omit free text',out.getvalue())

    def test_event_policy_requires_private_regular_single_link_file(self):
        policy=self.root/'policy';policy.mkdir(mode=0o700);file=policy/'policy.json';file.write_text('{}');file.chmod(0o644);key=policy/'binding.key';key.write_bytes(b'K'*32);key.chmod(0o600)
        with patch.object(launcher,'run_owned') as run:
            self.assertNotEqual(self.invoke(self.newargs()+['--events-policy-dir',str(policy)]),0);run.assert_not_called()
            file.chmod(0o600);link=self.root/'linked';os.link(file,link)
            self.assertNotEqual(self.invoke(self.newargs()+['--events-policy-dir',str(policy)]),0);run.assert_not_called()
            link.unlink();file.unlink();file.symlink_to(self.context)
            self.assertNotEqual(self.invoke(self.newargs()+['--events-policy-dir',str(policy)]),0);run.assert_not_called()

    def test_event_status_is_offline_and_policy_must_not_overlap_state(self):
        self.existing();policy=self.root/'policy';policy.mkdir(mode=0o700);file=policy/'policy.json';file.write_text('{}');file.chmod(0o600);key=policy/'binding.key';key.write_bytes(b'K'*32);key.chmod(0o600)
        with patch.object(launcher,'run_owned',return_value=0) as run:
            self.assertEqual(self.invoke(['status','--state',str(self.state),'--events-policy-dir',str(policy)]),0)
            cmd,env=run.call_args.args[:2];self.assertIn('recoverable_read_status',cmd);self.assertNotIn('MINIMAX_API_KEY',env)
            run.reset_mock();self.assertNotEqual(self.invoke(['status','--state',str(self.state),'--events-policy-dir',str(self.state)]),0);run.assert_not_called()

    def test_event_recording_rejects_unverified_024(self):
        policy=self.root/'policy';policy.mkdir(mode=0o700);file=policy/'policy.json';file.write_text('{}');file.chmod(0o600);key=policy/'binding.key';key.write_bytes(b'K'*32);key.chmod(0o600)
        with patch.dict(os.environ,{'NOMO_ETAS_VERSION':'0.2.4'}),patch.object(launcher,'run_owned') as run:
            self.assertNotEqual(self.invoke(self.newargs()+['--events-policy-dir',str(policy)]),0);run.assert_not_called()

    def test_status_outputs_stays_offline_and_is_explicit(self):
        self.existing()
        with patch.object(launcher,'run_owned',return_value=0) as run:
            self.assertEqual(self.invoke(['status','--state',str(self.state),'--outputs']),0)
        cmd,env=run.call_args.args[:2]
        self.assertEqual(cmd[-2:],['--args','--outputs'])
        self.assertNotIn('MINIMAX_API_KEY',env)
        self.assertFalse(any('nomo-minimax-read-compose.yaml' in value for value in cmd))

    def test_overlapping_or_nonprivate_state_refused_before_launch(self):
        with patch.object(launcher,'run_owned') as run:
            self.assertNotEqual(self.invoke(['new','--root',str(self.root),'--state',str(self.state),'--allow','x','--once','q']),0)
            self.state.chmod(0o755);self.assertNotEqual(self.invoke(self.newargs()),0);run.assert_not_called()
    def test_symlink_database_refused(self):
        self.existing();(self.state/'history.sqlite3').unlink();(self.state/'history.sqlite3').symlink_to(self.root/'outside')
        with patch.object(launcher,'run_owned') as run:
            self.assertNotEqual(self.invoke(['status','--state',str(self.state)]),0);run.assert_not_called()
    def test_lock_prevents_concurrent_launcher(self):
        self.existing();fd=os.open(self.state/'.nomo-session.lock',os.O_RDWR)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with patch.object(launcher,'run_owned') as run:
                self.assertNotEqual(self.invoke(['status','--state',str(self.state)]),0);run.assert_not_called()
        finally:os.close(fd)
    def test_sigterm_waits_for_owned_cleanup_while_retaining_lock(self):
        fake_root=self.root/'fake-project';(fake_root/'scripts').mkdir(parents=True)
        ready=self.root/'ready';signaled=self.root/'signaled';release=self.root/'release';finished=self.root/'finished'
        helper=fake_root/'scripts/terminal-transport.py'
        helper.write_text("""import os,pathlib,signal,sys,time
ready,signaled,release,finished=map(pathlib.Path,(os.environ['TEST_READY'],os.environ['TEST_SIGNALED'],os.environ['TEST_RELEASE'],os.environ['TEST_FINISHED']))
def stop(number,frame):
 signaled.write_text('signal received')
 deadline=time.monotonic()+5
 while not release.exists() and time.monotonic()<deadline:time.sleep(.02)
 finished.write_text('cleanup finished')
 raise SystemExit(143)
signal.signal(signal.SIGTERM,stop)
ready.write_text('ready')
while True:time.sleep(.02)
""")
        driver="""import importlib.util,sys,pathlib
spec=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.ROOT=pathlib.Path(sys.argv[2]);raise SystemExit(m.main(sys.argv[3:]))
"""
        env=dict(os.environ,TEST_READY=str(ready),TEST_SIGNALED=str(signaled),TEST_RELEASE=str(release),TEST_FINISHED=str(finished))
        proc=subprocess.Popen([sys.executable,'-B','-c',driver,str(ROOT/'scripts/nomo-read-session.py'),str(fake_root),*self.newargs()],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        def wait_for(path):
            deadline=time.monotonic()+8
            while not path.exists() and proc.poll() is None and time.monotonic()<deadline:time.sleep(.02)
            self.assertTrue(path.exists(),str(path))
        try:
            wait_for(ready);proc.send_signal(signal.SIGTERM);wait_for(signaled)
            fd=os.open(self.state/'.nomo-session.lock',os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertIsNone(proc.poll());release.touch()
                _,stderr=proc.communicate(timeout=8)
                self.assertEqual(proc.returncode,143);self.assertTrue(finished.exists());self.assertIn(b'Cancellation was requested.',stderr)
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(fd)
        finally:
            release.touch()
            if proc.poll() is None:proc.kill();proc.communicate(timeout=3)

    def test_new_requires_empty_state(self):
        (self.state/'other').write_text('existing')
        with patch.object(launcher,'run_owned') as run:
            self.assertNotEqual(self.invoke(self.newargs()),0);run.assert_not_called()
if __name__=='__main__':unittest.main()
