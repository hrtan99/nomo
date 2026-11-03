#!/usr/bin/env python3
"""Create and select bounded read-only sessions by a stable random ID."""
import argparse,importlib.util,os,re,secrets,shlex,stat,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
_spec=importlib.util.spec_from_file_location('nomo_edit_launcher',ROOT/'scripts/nomo-edit.py')
_edit=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_edit)
ID=re.compile(r'[0-9a-f]{32}\Z')

def registry(path):
    p=Path(path)
    if not p.is_absolute() or p.is_symlink():raise ValueError('sessions directory must be absolute and not a symlink')
    p=p.resolve(strict=True)
    fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    info=os.fstat(fd)
    if info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700:
        os.close(fd);raise ValueError('sessions directory must be owned by you with mode 0700')
    return p,fd

def session(registry_fd,base,identifier,create):
    if not ID.fullmatch(identifier):raise ValueError('session ID must contain exactly 32 lowercase hexadecimal characters')
    if create:
        os.mkdir(identifier,0o700,dir_fd=registry_fd)
        os.fsync(registry_fd)
    fd=os.open(identifier,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=registry_fd)
    try:
        st=os.fstat(fd)
        if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise ValueError('session state must be owned by you with mode 0700')
    finally:os.close(fd)
    return base/identifier

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('start','resume','status','work','followup','decision'));parser.add_argument('--sessions-dir',required=True)
    parser.add_argument('--id');parser.add_argument('--root');parser.add_argument('--allow');parser.add_argument('--once')
    parser.add_argument('--outputs',action='store_true')
    parser.add_argument('--events-policy-dir')
    parser.add_argument('--read-root');parser.add_argument('--operation-id');parser.add_argument('--path');parser.add_argument('--target',choices=('work','check','followup','followup-check'));parser.add_argument('--check',nargs=argparse.REMAINDER)
    args=parser.parse_args(argv)
    try:
        if args.action=='start' and args.id is not None:raise ValueError('a new session ID is generated automatically')
        if args.action!='start' and args.id is None:raise ValueError('select an existing session ID')
        if args.outputs and args.action!='status':raise ValueError('--outputs is only available for status')
        if args.events_policy_dir is not None and args.action not in ('start','resume','status','work'):raise ValueError('event-recording sessions do not yet support followup or decisions')
        if args.events_policy_dir is not None and args.outputs:raise ValueError('--outputs is unavailable for event-recording sessions')
        if args.id=='latest':raise ValueError('latest compatible session is unavailable: workspace identity continuity cannot yet be verified')
        if args.action=='decision':
            if args.operation_id is None or args.target is None:raise ValueError('select an operation ID and recovery target')
            if any(x is not None for x in (args.read_root,args.root,args.allow,args.once,args.path,args.check)):raise ValueError('decision accepts no work or read options')
        elif args.action in ('work','followup'):
            if args.target is not None:raise ValueError('--target is only for a recovery decision')
            if any(x is None for x in (args.read_root,args.root,args.allow,args.once,args.operation_id,args.path)):raise ValueError('select current read/edit roots, operation ID, path, allowlist and task')
            if args.check==[]:raise ValueError('--check requires a command')
        else:
            if any(x is not None for x in (args.read_root,args.operation_id,args.path,args.target,args.check)):raise ValueError('work or decision options require their action')
            if args.action=='status':
                if any(x is not None for x in (args.root,args.allow,args.once)):raise ValueError('status accepts no root, allowlist or task')
            elif any(x is None for x in (args.root,args.allow,args.once)):raise ValueError('select a current root, allowlist and task for each turn')
        base,fd=registry(args.sessions_dir)
        try:
            identifier=secrets.token_hex(16) if args.action=='start' else args.id
            state=session(fd,base,identifier,args.action=='start')
        finally:os.close(fd)
        print('SESSION ID '+identifier,flush=True)
        if args.action=='start':print('Resume: nomo-read.sh session-id resume --sessions-dir '+shlex.quote(str(base))+' --id '+identifier+' --root DIR --allow FILE --once QUESTION'+(' --events-policy-dir '+shlex.quote(args.events_policy_dir) if args.events_policy_dir is not None else ''),flush=True)
        if args.action in ('start','resume','work','followup'):print('Current root is newly selected; session ID does not prove workspace identity or reuse approval.',flush=True)
        if args.action=='decision':
            command=[sys.executable,str(ROOT/'scripts/nomo-recovery-decision.py'),'--state',str(state),'--id='+args.operation_id,'--target',args.target]
        elif args.action in ('work','followup'):
            command=[sys.executable,str(ROOT/('scripts/nomo-history-followup.py' if args.action=='followup' else 'scripts/nomo-history-work.py')),'--state',str(state),'--read-root',args.read_root,'--root',args.root,'--id='+args.operation_id,'--path='+args.path,'--allow='+args.allow,'--once='+args.once]
            if args.events_policy_dir is not None:command+=['--events-policy-dir',args.events_policy_dir]
            if args.check is not None:command+=['--check',*args.check]
        else:
            mode={'start':'new','resume':'continue','status':'status'}[args.action]
            command=[sys.executable,str(ROOT/'scripts/nomo-read-session.py'),mode,'--state',str(state)]
            if mode!='status':command+=['--root',args.root,'--allow='+args.allow,'--once='+args.once]
            elif args.outputs:command+=['--outputs']
            if args.events_policy_dir is not None:command+=['--events-policy-dir',args.events_policy_dir]
        code=_edit.run_owned(command,dict(os.environ))
        if code:print('Session state is retained; inspect it before another action.',file=sys.stderr,flush=True)
        return code
    except (OSError,ValueError) as error:
        print('REFUSED '+str(error),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
