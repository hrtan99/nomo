#!/usr/bin/env python3
"""Create and select workspace-bound sessions by a stable random ID."""
import argparse,importlib.util,json,os,re,secrets,shlex,stat,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
_spec=importlib.util.spec_from_file_location('nomo_edit_launcher',ROOT/'scripts/nomo-edit.py')
_edit=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_edit)
ID=re.compile(r'[0-9a-f]{32}\Z')
WORKSPACE_FILE='.nomo-workspace.json'

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

def workspace_identity(path):
    value=Path(path)
    if not value.is_absolute() or value.is_symlink():raise ValueError('workspace must be absolute with a non-symlink leaf')
    value=value.resolve(strict=True)
    fd=os.open(value,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:info=os.fstat(fd)
    finally:os.close(fd)
    return {'path':str(value),'device':info.st_dev,'inode':info.st_ino}

def _object(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise ValueError('duplicate workspace binding field')
        result[key]=value
    return result

def _read_file(directory_fd,name,maximum):
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory_fd)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600:
            raise ValueError(name+' must be a private regular file')
        data=b''
        while len(data)<=maximum:
            part=os.read(fd,maximum+1-len(data))
            if not part:break
            data+=part
        if len(data)>maximum:raise ValueError(name+' exceeds its size bound')
        return data,info.st_mtime_ns
    finally:os.close(fd)

def read_workspace_binding(directory_fd,required=False):
    try:data,_=_read_file(directory_fd,WORKSPACE_FILE,8192)
    except FileNotFoundError:
        if required:raise ValueError('workspace binding is missing')
        return None
    try:value=json.loads(data,object_pairs_hook=_object)
    except (UnicodeDecodeError,json.JSONDecodeError) as error:raise ValueError('invalid workspace binding') from error
    if not isinstance(value,dict) or set(value)!= {'format','workspace','created_ns','used_ns'} or value.get('format')!=1:
        raise ValueError('unsupported workspace binding')
    identity=value.get('workspace')
    if not isinstance(identity,dict) or set(identity)!= {'path','device','inode'}:
        raise ValueError('invalid workspace identity')
    path=identity.get('path');device=identity.get('device');inode=identity.get('inode')
    if not isinstance(path,str) or not path.startswith('/') or not path or len(path.encode('utf-8'))>4096 or any(ord(c)<32 for c in path):
        raise ValueError('invalid workspace path')
    if isinstance(device,bool) or isinstance(inode,bool) or not isinstance(device,int) or not isinstance(inode,int) or device<0 or inode<=0:
        raise ValueError('invalid workspace directory identity')
    for name in ('created_ns','used_ns'):
        stamp=value.get(name)
        if isinstance(stamp,bool) or not isinstance(stamp,int) or not 0<stamp<2**63:raise ValueError('invalid workspace binding time')
    if value['used_ns']<value['created_ns']:raise ValueError('invalid workspace binding order')
    return value

def write_workspace_binding(directory_fd,value):
    data=(json.dumps(value,ensure_ascii=False,separators=(',',':'),sort_keys=True)+'\n').encode('utf-8')
    if len(data)>8192:raise ValueError('workspace binding exceeds its size bound')
    temporary='.'+WORKSPACE_FILE+'.'+secrets.token_hex(16)+'.tmp'
    fd=None
    try:
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory_fd)
        if os.write(fd,data)!=len(data):raise OSError('workspace binding write incomplete')
        os.fsync(fd);os.close(fd);fd=None
        os.rename(temporary,WORKSPACE_FILE,src_dir_fd=directory_fd,dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        if fd is not None:os.close(fd)
        try:os.unlink(temporary,dir_fd=directory_fd)
        except FileNotFoundError:pass

def bind_workspace(state,identity):
    fd=os.open(state,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        if read_workspace_binding(fd) is not None:raise ValueError('new session already has a workspace binding')
        now=time.time_ns();value={'format':1,'workspace':identity,'created_ns':now,'used_ns':now}
        write_workspace_binding(fd,value)
        return value
    finally:os.close(fd)

def verify_workspace(state,path):
    fd=os.open(state,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:value=read_workspace_binding(fd)
    finally:os.close(fd)
    if value is not None and value['workspace']!=workspace_identity(path):raise ValueError('session belongs to a different workspace')
    return value

def touch_workspace_binding(state):
    fd=os.open(state,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        value=read_workspace_binding(fd)
        if value is None:return
        value['used_ns']=max(time.time_ns(),value['used_ns'])
        write_workspace_binding(fd,value)
    finally:os.close(fd)

def compatible_state(directory_fd):
    try:
        graph,_=_read_file(directory_fd,'.nomo-session.lock',32)
        fd=os.open('history.sqlite3',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory_fd)
        try:
            info=os.fstat(fd)
            history=stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600 and info.st_size>0
        finally:os.close(fd)
    except (OSError,ValueError):return False
    return _edit.compatible_session_graph(graph) and history

def compatible_candidates(registry_fd,identity):
    choices=[]
    for identifier in os.listdir(registry_fd):
        if not ID.fullmatch(identifier):continue
        try:fd=os.open(identifier,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=registry_fd)
        except OSError:continue
        try:
            info=os.fstat(fd)
            if info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700:continue
            try:value=read_workspace_binding(fd)
            except (OSError,ValueError):continue
            if value is not None and value['workspace']==identity and compatible_state(fd):choices.append((value['used_ns'],identifier))
        finally:os.close(fd)
    return [identifier for _,identifier in sorted(choices,reverse=True)]

def probe_session(state,events_policy_dir):
    command=[sys.executable,str(ROOT/'scripts/nomo-read-session.py'),'status','--state',str(state)]
    if events_policy_dir is not None:command+=['--events-policy-dir',events_policy_dir]
    captured={}
    code=_edit.run_owned(command,_edit.without_model(os.environ),captured,capture_limit=1048576,forward_output=False)
    output=bytes(captured.get('stdout',{}).get('data',b''))+bytes(captured.get('stderr',{}).get('data',b''))
    truncated=any(item.get('truncated') for item in captured.values())
    if code==0 and not truncated:return True
    if code in (125,130) or truncated or b'session already in use' in output:
        raise ValueError('latest session compatibility could not be verified safely')
    return False

def latest_compatible(registry_fd,base,identity,events_policy_dir):
    choices=compatible_candidates(registry_fd,identity)
    if not choices:raise ValueError('no compatible session is bound to the current workspace')
    for identifier in choices:
        if probe_session(base/identifier,events_policy_dir):return identifier
    raise ValueError('no resumable compatible session is bound to the current workspace')

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('start','resume','status','work','followup','decision','init'));parser.add_argument('--sessions-dir',required=True)
    parser.add_argument('--id');parser.add_argument('--root');parser.add_argument('--allow');parser.add_argument('--once')
    parser.add_argument('--workspace-root',help=argparse.SUPPRESS)
    parser.add_argument('--outputs',action='store_true')
    parser.add_argument('--events',action='store_true')
    parser.add_argument('--events-policy-dir');parser.add_argument('--high-input',action='store_true')
    parser.add_argument('--read-root');parser.add_argument('--operation-id');parser.add_argument('--path');parser.add_argument('--target',choices=('work','check','followup','followup-check'));parser.add_argument('--natural-work',action='store_true');parser.add_argument('--interactive-check',action='store_true',help=argparse.SUPPRESS);parser.add_argument('--check',nargs=argparse.REMAINDER)
    args=parser.parse_args(argv)
    try:
        if args.natural_work and args.action not in ('start','resume'):raise ValueError('natural work routing requires a read turn')
        if args.high_input and (args.action not in ('start','init') or args.events_policy_dir is None):raise ValueError('high-input mode requires a new event-recording session')
        if args.interactive_check and args.action not in ('work','followup'):raise ValueError('interactive check requires a work action')
        if args.action in ('start','init') and args.id is not None:raise ValueError('a new session ID is generated automatically')
        if args.action not in ('start','init') and args.id is None:raise ValueError('select an existing session ID')
        if (args.outputs or args.events) and args.action!='status':raise ValueError('--outputs and --events are only available for status')
        if args.events and args.events_policy_dir is None:raise ValueError('--events requires event-recording mode and its policy')
        if args.events and args.outputs:raise ValueError('--events and --outputs cannot be combined')
        if args.events_policy_dir is not None and args.action not in ('start','resume','status','work','followup','init'):raise ValueError('event-recording sessions do not yet support decisions')
        if args.events_policy_dir is not None and args.outputs:raise ValueError('--outputs is unavailable for event-recording sessions')
        if args.action=='decision':
            if args.operation_id is None or args.target is None:raise ValueError('select an operation ID and recovery target')
            if any(x is not None for x in (args.read_root,args.root,args.allow,args.once,args.path,args.check,args.workspace_root)):raise ValueError('decision accepts no work or read options')
        elif args.action in ('work','followup'):
            if args.target is not None:raise ValueError('--target is only for a recovery decision')
            if any(x is None for x in (args.read_root,args.root,args.allow,args.once,args.operation_id,args.path)):raise ValueError('select current read/edit roots, operation ID, path, allowlist and task')
            if args.check==[]:raise ValueError('--check requires a command')
            if args.workspace_root is not None:raise ValueError('work actions use the current read root as workspace identity')
        else:
            if any(x is not None for x in (args.read_root,args.operation_id,args.path,args.target,args.check)):raise ValueError('work or decision options require their action')
            if args.action in ('status','init'):
                if any(x is not None for x in (args.root,args.allow,args.once)):raise ValueError('status or init accepts no root, allowlist or task')
                if args.action=='init' and args.events_policy_dir is None:raise ValueError('init requires an event policy')
                if args.action=='status' and args.workspace_root is not None:raise ValueError('status accepts no workspace root')
            elif any(x is None for x in (args.root,args.allow,args.once)):raise ValueError('select a current root, allowlist and task for each turn')
            elif args.workspace_root is not None:raise ValueError('read actions use their current root as workspace identity')
        workspace_root=args.workspace_root if args.action=='init' else args.read_root if args.action in ('work','followup') else args.root if args.action in ('start','resume') else None
        identity=None
        base,fd=registry(args.sessions_dir)
        try:
            if args.id=='latest':
                if args.action!='resume':raise ValueError('latest selection is available only for resume')
                if workspace_root is None:raise ValueError('latest selection requires a current workspace')
                identity=workspace_identity(workspace_root)
                identifier=latest_compatible(fd,base,identity,args.events_policy_dir)
            else:identifier=secrets.token_hex(16) if args.action in ('start','init') else args.id
            state=session(fd,base,identifier,args.action in ('start','init'))
        finally:os.close(fd)
        if args.action in ('start','init') and workspace_root is not None:
            identity=identity or workspace_identity(workspace_root)
            binding=bind_workspace(state,identity)
        else:binding=verify_workspace(state,workspace_root) if workspace_root is not None else None
        print('SESSION ID '+identifier,flush=True)
        if args.action=='start':print('Resume: nomo-read.sh session-id resume --sessions-dir '+shlex.quote(str(base))+' --id '+identifier+' --root DIR --allow FILE --once QUESTION'+(' --events-policy-dir '+shlex.quote(args.events_policy_dir) if args.events_policy_dir is not None else ''),flush=True)
        if args.action in ('start','resume','work','followup'):
            print(('Workspace binding recorded and verified using its canonical path and directory identity.' if binding is not None else 'Historical session has no workspace binding; its explicit ID does not prove workspace identity.')+' Current scope and reuse approval are newly selected.',flush=True)
        if args.action=='decision':
            command=[sys.executable,str(ROOT/'scripts/nomo-history-work.py'),'--recovery-decision','--state',str(state),'--id='+args.operation_id,'--target',args.target]
        elif args.action in ('work','followup'):
            command=[sys.executable,str(ROOT/'scripts/nomo-history-work.py'),*(['--followup'] if args.action=='followup' else []),'--state',str(state),'--read-root',args.read_root,'--root',args.root,'--id='+args.operation_id,'--path='+args.path,'--allow='+args.allow,'--once='+args.once]
            if args.events_policy_dir is not None:command+=['--events-policy-dir',args.events_policy_dir]
            if args.interactive_check:command+=['--interactive-check']
            if args.check is not None:command+=['--check',*args.check]
        else:
            mode={'start':'new','resume':'continue','status':'status','init':'init'}[args.action]
            command=[sys.executable,str(ROOT/'scripts/nomo-read-session.py'),mode,'--state',str(state)]
            if mode in ('new','continue'):command+=['--root',args.root,'--allow='+args.allow,'--once='+args.once]
            elif args.outputs:command+=['--outputs']
            elif args.events:command+=['--events']
            if args.events_policy_dir is not None:command+=['--events-policy-dir',args.events_policy_dir]
            if args.natural_work:command+=['--natural-work']
            if args.high_input:command+=['--high-input']
        code=_edit.run_owned(command,dict(os.environ))
        if code==0 and binding is not None and args.action!='status':touch_workspace_binding(state)
        if code:print('Session state is retained; inspect it before another action.',file=sys.stderr,flush=True)
        return code
    except (OSError,ValueError) as error:
        print('REFUSED '+str(error),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
