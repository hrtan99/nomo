#!/usr/bin/env python3
"""Run one newly approved followup edit using saved conversation and prior work as untrusted context."""
import argparse,fcntl,hashlib,importlib.util,json,os,re,stat,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('nomo_edit_launcher',ROOT/'scripts/nomo-edit.py');edit=importlib.util.module_from_spec(spec);spec.loader.exec_module(edit)
storage_spec=importlib.util.spec_from_file_location('nomo_session_storage',ROOT/'scripts/nomo-session-storage.py');storage=importlib.util.module_from_spec(storage_spec);storage_spec.loader.exec_module(storage)

def main(argv=None):
    argv=list(sys.argv[1:] if argv is None else argv)
    options=argv[:argv.index('--check')] if '--check' in argv else argv
    if any(item=='--events-policy-dir' or item.startswith('--events-policy-dir=') for item in options):
        followup_spec=importlib.util.spec_from_file_location('nomo_event_work_launcher',ROOT/'scripts/nomo-history-work.py')
        followup=importlib.util.module_from_spec(followup_spec);followup_spec.loader.exec_module(followup)
        return followup.main(['--event-followup',*argv])
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--read-root',required=True);parser.add_argument('--root',required=True);parser.add_argument('--state',required=True)
    parser.add_argument('--id',required=True);parser.add_argument('--path',required=True);parser.add_argument('--allow',required=True);parser.add_argument('--once',required=True)
    parser.add_argument('--interactive-check',action='store_true',help=argparse.SUPPRESS)
    parser.add_argument('--check',nargs=argparse.REMAINDER)
    args=parser.parse_args(argv)
    try:
        if not sys.stdin.isatty() or not sys.stdout.isatty():raise ValueError('editing requires an interactive terminal for both confirmations')
        if args.check==[]:raise ValueError('--check requires a command')
        context=edit.directory(args.read_root,'read root');workspace=edit.directory(args.root,'workspace');state=edit.directory(args.state,'state')
        for item in (context,workspace):
            if item==state or item in state.parents or state in item.parents:raise ValueError('state must not overlap read or edit roots')
        info=state.stat();workinfo=workspace.stat()
        if info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700:raise ValueError('state must be owned by you with mode 0700')
        if workinfo.st_uid!=os.getuid() or stat.S_IMODE(workinfo.st_mode)&0o022:raise ValueError('workspace must be owned by you and not writable by group or others')
        cache=ROOT/'.etas'
        if cache.is_symlink():raise ValueError('project .etas mountpoint must not be a symlink')
        cache.mkdir(mode=0o700,exist_ok=True)
        if cache.is_symlink() or not cache.is_dir():raise ValueError('project .etas mountpoint must be a directory')
        version=os.environ.get('NOMO_ETAS_VERSION','0.2.6')
        if version!='0.2.6':raise ValueError('this Nomo revision requires ETAS 0.2.6; use an earlier Nomo revision for older ETAS')
        overlay='config/etas-'+version.replace('.','')+'-official-compose.yaml'
        if not os.environ.get('MINIMAX_API_KEY'):raise ValueError('set MINIMAX_API_KEY to the M Plan key')
        deadline=os.environ.get('NOMO_MODEL_REQUEST_DEADLINE_MS','120000')
        if not deadline.isascii() or not deadline.isdigit() or len(deadline)>7 or not 2000<=int(deadline)<=3600000:raise ValueError('model request deadline must be an integer from 2000 to 3600000')
        names=args.allow.split(',')
        if not 1<=len(names)<=4 or len(set(names))!=len(names) or any(not edit.safe_path(n, 48) for n in names) or len(args.allow.encode('utf-8'))>195:raise ValueError('allow must name one to four distinct safe relative files')
        if not edit.safe_read_question(args.once):raise ValueError('work task must be 1..128 safe nonblank UTF-8 bytes')
        selected=Path(args.path)
        if not args.id or not edit.safe_path(args.path):raise ValueError('select an ID and relative workspace file')
        current=workspace
        for part in selected.parts:
            current=current/part
            if current.is_symlink():raise ValueError('selected file path must not contain symlinks')
        if not current.is_file():raise ValueError('selected file must be an existing regular file')
        fd=os.open(state/'.nomo-session.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            lock=os.fstat(fd)
            if not stat.S_ISREG(lock.st_mode) or lock.st_uid!=os.getuid() or lock.st_nlink!=1 or stat.S_IMODE(lock.st_mode)!=0o600:raise ValueError('session lock must be a private regular file')
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise ValueError('session already in use')
            storage.prepare(state)
            env={k:v for k,v in os.environ.items() if not k.startswith('ETAS_HOST_')}
            env.pop('NOMO_QWEN_SERVER_API_KEY',None)
            env.update(NOMO_SESSION_STATE=str(state),NOMO_EDIT_WORKSPACE_DIR=str(workspace),NOMO_WORK_CONTEXT_DIR=str(context),NOMO_ETAS_VERSION=version)
            compose=['docker','compose','--env-file','/dev/null','--file',str(ROOT/'compose.yaml'),
                '--file',str(ROOT/overlay),'--file',str(ROOT/'config/etas-runtime-cache-compose.yaml'),
                '--file',str(ROOT/'config/nomo-minimax-model-compose.yaml'),'--file',str(ROOT/'config/nomo-read-session-compose.yaml'),
                '--file',str(ROOT/'config/nomo-history-work-compose.yaml')]
            native=['python3','-B','/workspace/scripts/nomo-verified-etas.py','run','/workspace','--flow','history_followup','--profile','nomo-history-work','--allow-effects',
                '--args','--id',args.id,'--workspace','private-workspace','--path',args.path,'--once',args.once,'--allow',args.allow]
            check_ref=hashlib.sha256(json.dumps(args.check,ensure_ascii=True,separators=(',',':')).encode()).hexdigest() if args.check else None
            if check_ref:native+=['--check-ref',check_ref]
            command=[sys.executable,str(ROOT/'scripts/terminal-transport.py'),*compose,'run','--rm','--no-deps','--pull','never','--tty=true','--workdir','/session-state','dev',*native]
            print('Prior conversation and first work/check are untrusted model context. Current read and edit roots are newly selected; no prior approval is reused.',flush=True)
            print('Additional reservation: up to 7 model calls and 47104 output tokens; together both work rounds reserve up to 14 calls and 94208 output tokens, plus chat.',flush=True)
            print('Context, task, history and file may be sent to MiniMax. A new preview and two confirmations are required.',flush=True)
            if version=='0.2.4':print('ETAS 0.2.4 does not expose the provider finish reason.',flush=True)
            diagnostic=edit.RuntimeDiagnostic()
            code=edit.run_owned(command,env,diagnostic=diagnostic)
            if code!=0:
                diagnostic.report(code)
                print('Work stopped. Inspect the edit and durable state before any further action; the outcome may be uncertain.',file=sys.stderr,flush=True);return code
            if not args.check:
                print('Edit completed; no check was requested.',flush=True);return 0
            check,check_env=edit.prepare_project_check(str(workspace),args.check,version=version)
            internal_env={k:v for k,v in env.items() if not k.startswith('ETAS_HOST_') and k not in ('MINIMAX_API_KEY','NOMO_QWEN_SERVER_API_KEY','NOMO_MODEL_REQUEST_DEADLINE_MS')}
            offline=['docker','compose','--env-file','/dev/null','--file',str(ROOT/'compose.yaml'),
                '--file',str(ROOT/overlay),'--file',str(ROOT/'config/etas-runtime-cache-compose.yaml'),
                '--file',str(ROOT/'config/nomo-read-session-compose.yaml')]
            def checkpoint(action,*extra,input_data=None):
                native_check=['python3','-B','/workspace/scripts/nomo-verified-etas.py','run','/workspace','--flow','history_followup_check',
                    '--profile','nomo-read-session-status','--allow-effects','--args',action,args.id,check_ref,*extra]
                command_check=[sys.executable,str(ROOT/'scripts/terminal-transport.py'),*offline,'run','--rm','--no-deps','--pull','never',
                    '--tty=false','--workdir','/session-state','dev',*native_check]
                if input_data is not None:return edit.run_owned(command_check,internal_env,input_data=input_data)
                return edit.run_owned(command_check,internal_env)
            if checkpoint('start'):
                print('Check was not started; inspect recorded status.',file=sys.stderr,flush=True);return 1
            print('Running the requested check offline in the edited workspace (60-second limit; stdin is closed).',flush=True)
            capture={key:{'data':bytearray(),'truncated':False} for key in ('stdout','stderr')}
            code=edit.run_owned(check,check_env,capture)
            if code<0 or code>=124:
                print('Check outcome is uncertain; recorded running state is retained, without retry.',file=sys.stderr,flush=True);return code or 1
            outcome='passed' if code==0 else 'failed'
            if checkpoint('finish',outcome,str(code)):
                print('Check finished but its outcome was not confirmed in session state.',file=sys.stderr,flush=True);return 1
            stdout=edit.format_check_capture(capture['stdout'],env);stderr=edit.format_check_capture(capture['stderr'],env)
            if checkpoint('output',str(capture['stdout']['truncated']).lower(),str(capture['stderr']['truncated']).lower(),input_data=(json.dumps([stdout,stderr],ensure_ascii=True)+'\n').encode()):
                print('Check completed but its diagnostic output was not recorded.',file=sys.stderr,flush=True);return 1
            if code:
                print('Check failed (exit '+str(code)+'); ask for a fix or inspect status.',file=sys.stderr,flush=True);return 0 if args.interactive_check else code
            print('Check passed.',flush=True);return 0
        finally:os.close(fd)
    except (OSError,ValueError) as error:
        print('REFUSED '+str(error),file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
