#!/usr/bin/env python3
"""Run or inspect a bounded, durable read-only conversation."""
import argparse, fcntl, importlib.util, os, stat, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
_spec=importlib.util.spec_from_file_location('nomo_edit_launcher',ROOT/'scripts/nomo-edit.py')
_edit_launcher=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_edit_launcher)
run_owned=_edit_launcher.run_owned

def directory(value,label):
    path=Path(value)
    if not path.is_absolute() or path.is_symlink():raise ValueError(label+' must be an absolute directory with a non-symlink leaf')
    path=path.resolve(strict=True)
    if not path.is_dir():raise ValueError(label+' must be a directory')
    return path

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('new','continue','status'));parser.add_argument('--state',required=True)
    parser.add_argument('--root');parser.add_argument('--allow');parser.add_argument('--once')
    args=parser.parse_args(argv)
    try:
        status=args.action=='status';state=directory(args.state,'state');context=None
        if status:
            if args.root is not None or args.allow is not None or args.once is not None:raise ValueError('status accepts only --state')
        else:
            if args.root is None or args.allow is None or args.once is None:raise ValueError('select --root, --allow and --once for each turn')
            context=directory(args.root,'read root')
            if context==state or context in state.parents or state in context.parents:raise ValueError('read root and state must not overlap')
            if not os.environ.get('MINIMAX_API_KEY'):raise ValueError('set MINIMAX_API_KEY before starting MiniMax')
        version=os.environ.get('NOMO_ETAS_VERSION','0.2.5')
        if version not in ('0.2.4','0.2.5'):raise ValueError('read sessions require ETAS 0.2.4 or 0.2.5')
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
            for suffix in ('','-wal','-shm','-journal'):
                p=state/('history.sqlite3'+suffix)
                if p.is_symlink():raise ValueError('session database and sidecars must not be symlinks')
                if p.exists():
                    info=p.stat()
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise ValueError('session database and sidecars must be regular files without hardlinks')
            env=dict(os.environ,NOMO_SESSION_STATE=str(state),NOMO_ETAS_VERSION=version)
            env.pop('NOMO_QWEN_SERVER_API_KEY',None)
            compose=['docker','compose','--env-file','/dev/null','--file',str(ROOT/'compose.yaml'),
                     '--file',str(ROOT/('config/etas-025-official-compose.yaml' if version=='0.2.5' else 'config/etas-024-official-compose.yaml')),'--file',str(ROOT/'config/etas-runtime-cache-compose.yaml')]
            if status:
                env.pop('MINIMAX_API_KEY',None);env.pop('ETAS_HOST_MODEL_API_KEY',None)
                profile='nomo-read-session-status';flow='read_session_status';native_args=[]
                print('Inspecting recorded status offline; SQLite may update bookkeeping.',flush=True)
            else:
                env['NOMO_READ_ROOT']=str(context);profile='nomo-read-session-new' if args.action=='new' else 'nomo-read-session-existing'
                flow='read_session';native_args=['--args',args.action,'--allow',args.allow,'--once',args.once]
                compose+=['--file',str(ROOT/'config/local-tryout-compose.yaml'),'--file',str(ROOT/'config/nomo-minimax-read-compose.yaml')]
                print('Current read root and allowlist are newly selected. Saved history is untrusted context and may be sent to MiniMax.',flush=True)
                print('Conversation snapshots may retain request, tool-result and answer text; event labels omit free text. Full secret redaction is not available.',flush=True)
                print('MiniMax thinking counts against output limits; ETAS 0.2.4 does not expose the provider finish reason.',flush=True)
                print('A running or uncertain turn cannot be retried; this does not establish workspace identity continuity.',flush=True)
            compose+=['--file',str(ROOT/'config/nomo-read-session-compose.yaml')]
            native=['python3','-B','/workspace/scripts/nomo-verified-etas.py','run','/workspace','--flow',flow,'--profile',profile,'--allow-effects',*native_args]
            command=[sys.executable,str(ROOT/'scripts/terminal-transport.py'),*compose,'run','--rm','--no-deps','--pull','never','--tty=false','--workdir','/session-state','dev',*native]
            return run_owned(command,env)
        finally:os.close(fd)
    except (ValueError,OSError) as error:
        print('REFUSED '+str(error),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
