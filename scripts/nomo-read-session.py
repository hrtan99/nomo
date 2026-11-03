#!/usr/bin/env python3
"""Run or inspect a bounded, durable read-only conversation."""
import argparse, fcntl, importlib.util, os, stat, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
_spec=importlib.util.spec_from_file_location('nomo_edit_launcher',ROOT/'scripts/nomo-edit.py')
_edit_launcher=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_edit_launcher)
run_owned=_edit_launcher.run_owned
_storage_spec=importlib.util.spec_from_file_location('nomo_session_storage',ROOT/'scripts/nomo-session-storage.py')
_storage=importlib.util.module_from_spec(_storage_spec);_storage_spec.loader.exec_module(_storage)
_policy_spec=importlib.util.spec_from_file_location('nomo_event_policy',ROOT/'scripts/nomo-event-policy.py')
_policy=importlib.util.module_from_spec(_policy_spec);_policy_spec.loader.exec_module(_policy)

def directory(value,label):
    path=Path(value)
    if not path.is_absolute() or path.is_symlink():raise ValueError(label+' must be an absolute directory with a non-symlink leaf')
    path=path.resolve(strict=True)
    if not path.is_dir():raise ValueError(label+' must be a directory')
    return path

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('new','continue','status'));parser.add_argument('--state',required=True)
    parser.add_argument('--root');parser.add_argument('--allow');parser.add_argument('--once');parser.add_argument('--outputs',action='store_true');parser.add_argument('--events-policy-dir')
    args=parser.parse_args(argv)
    try:
        status=args.action=='status';state=directory(args.state,'state');context=None
        if status:
            if args.root is not None or args.allow is not None or args.once is not None:raise ValueError('status accepts only --state')
        else:
            if args.outputs:raise ValueError('--outputs is only available for status')
            if args.root is None or args.allow is None or args.once is None:raise ValueError('select --root, --allow and --once for each turn')
            context=directory(args.root,'read root')
            if context==state or context in state.parents or state in context.parents:raise ValueError('read root and state must not overlap')
            if not os.environ.get('MINIMAX_API_KEY'):raise ValueError('set MINIMAX_API_KEY before starting MiniMax')
        policy=None;policy_bytes=None;policy_binding=None
        if args.events_policy_dir is not None:
            if args.outputs:raise ValueError('--outputs is unavailable for event-recording sessions')
            policy,policy_bytes,policy_binding=_policy.read_private(args.events_policy_dir)
            if policy==state or policy in state.parents or state in policy.parents or (context is not None and (policy==context or policy in context.parents or context in policy.parents)):raise ValueError('event policy directory must not overlap state or workspace')
        version=os.environ.get('NOMO_ETAS_VERSION','0.2.5')
        if version not in ('0.2.4','0.2.5'):raise ValueError('read sessions require ETAS 0.2.4 or 0.2.5')
        if policy is not None and version!='0.2.5':raise ValueError('event-recording sessions require ETAS 0.2.5')
        st=state.stat()
        if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise ValueError('state must be owned by you with mode 0700')
        cache=ROOT/'.etas'
        if cache.is_symlink():raise ValueError('project .etas mountpoint must not be a symlink')
        cache.mkdir(mode=0o700,exist_ok=True)
        if cache.is_symlink() or not cache.is_dir():raise ValueError('project .etas mountpoint must be a directory')
        flags=os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC
        if args.action=='new':flags|=os.O_CREAT
        fd=os.open(state/'.nomo-session.lock',flags,0o600)
        try:
            lock=os.fstat(fd)
            if not stat.S_ISREG(lock.st_mode) or lock.st_uid!=os.getuid() or lock.st_nlink!=1 or stat.S_IMODE(lock.st_mode)!=0o600:
                raise ValueError('session lock must be a private regular file')
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise ValueError('session already in use')
            names={p.name for p in state.iterdir()}
            if args.action=='new' and names!={'.nomo-session.lock'}:raise ValueError('new session state must otherwise be empty')
            if args.action!='new' and 'history.sqlite3' not in names:raise ValueError('existing session history is missing')
            _storage.prepare(state,create=args.action=='new')
            env=dict(os.environ,NOMO_SESSION_STATE=str(state),NOMO_ETAS_VERSION=version)
            env.pop('NOMO_QWEN_SERVER_API_KEY',None)
            compose=['docker','compose','--env-file','/dev/null','--file',str(ROOT/'compose.yaml'),
                     '--file',str(ROOT/('config/etas-025-official-compose.yaml' if version=='0.2.5' else 'config/etas-024-official-compose.yaml')),'--file',str(ROOT/'config/etas-runtime-cache-compose.yaml')]
            if status:
                env.pop('MINIMAX_API_KEY',None);env.pop('ETAS_HOST_MODEL_API_KEY',None)
                profile='nomo-read-session-status';flow='read_session_status';native_args=['--args','--outputs'] if args.outputs else []
                print('Inspecting recorded status offline; SQLite may update bookkeeping.',flush=True)
            else:
                env['NOMO_READ_ROOT']=str(context);profile='nomo-read-session-new' if args.action=='new' else 'nomo-read-session-existing'
                flow='read_session';native_args=['--args',args.action,'--allow',args.allow,'--once',args.once]
                compose+=['--file',str(ROOT/'config/local-tryout-compose.yaml'),'--file',str(ROOT/'config/nomo-minimax-read-compose.yaml')]
                print('Current read root and allowlist are newly selected. Saved history is untrusted context and may be sent to MiniMax.',flush=True)
                if policy is None:print('Conversation snapshots may retain request, tool-result and answer text; event labels omit free text. Full secret redaction is not available.',flush=True)
                else:print('Event records retain bounded conversation and tool-result text. Only supplied exact literals are filtered; unknown secrets and live terminal output are not comprehensively filtered.',flush=True)
                print('MiniMax thinking counts against output limits; ETAS 0.2.4 does not expose the provider finish reason.',flush=True)
                print('A running or uncertain turn cannot be retried; this does not establish workspace identity continuity.',flush=True)
            if policy is not None:
                profile='nomo-read-events-status' if status else ('nomo-read-events-new' if args.action=='new' else 'nomo-read-events-existing')
                flow='recoverable_read_status' if status else 'recoverable_read_session'
                if status:native_args=['--args','--policy-binding',policy_binding]
                else:native_args+=['--policy-binding',policy_binding]
                print('Event recording is read-only and opt-in; policy filters only supplied exact literals. Unknown secrets may remain. Keep the same private policy and binding key; workspace identity is not established.',flush=True)
            compose+=['--file',str(ROOT/'config/nomo-read-session-compose.yaml')]
            runner='/workspace/scripts/nomo-event-policy-bootstrap.py' if policy is not None else '/workspace/scripts/nomo-verified-etas.py'
            native=['python3','-B',runner,'run','/workspace','--flow',flow,'--profile',profile,'--allow-effects',*native_args]
            command=[sys.executable,str(ROOT/'scripts/terminal-transport.py'),*compose,'run','--rm','--no-deps','--pull','never','--tty=false','--workdir','/session-state','dev',*native]
            if status:
                if policy is not None:return run_owned(command,env,input_data=policy_bytes)
                return run_owned(command,env)
            diagnostic=_edit_launcher.RuntimeDiagnostic()
            if policy is not None:code=run_owned(command,env,diagnostic=diagnostic,input_data=policy_bytes)
            else:code=run_owned(command,env,diagnostic=diagnostic)
            if code:diagnostic.report(code)
            return code
        finally:os.close(fd)
    except (ValueError,OSError) as error:
        print('REFUSED '+str(error),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
