#!/usr/bin/env python3
"""Run one newly approved edit using saved conversation as untrusted context."""
import argparse,fcntl,hashlib,importlib.util,json,os,re,stat,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('nomo_edit_launcher',ROOT/'scripts/nomo-edit.py');edit=importlib.util.module_from_spec(spec);spec.loader.exec_module(edit)
storage_spec=importlib.util.spec_from_file_location('nomo_session_storage',ROOT/'scripts/nomo-session-storage.py');storage=importlib.util.module_from_spec(storage_spec);storage_spec.loader.exec_module(storage)
policy_spec=importlib.util.spec_from_file_location('nomo_event_policy',ROOT/'scripts/nomo-event-policy.py');policy_module=importlib.util.module_from_spec(policy_spec);policy_spec.loader.exec_module(policy_module)

def route_followup(raw):
    if raw[:1]!=['--followup']:return raw
    argv=raw[1:];options=argv[:argv.index('--check')] if '--check' in argv else argv
    event=any(item=='--events-policy-dir' or item.startswith('--events-policy-dir=') for item in options)
    return ['--event-followup' if event else '--legacy-followup',*argv]

def recovery_decision(argv):
    parser=argparse.ArgumentParser(description='Record an explicit decision to abandon an unresolved operation.')
    parser.add_argument('--state',required=True);parser.add_argument('--id',required=True);parser.add_argument('--target',choices=('work','check','followup','followup-check'),required=True);args=parser.parse_args(argv)
    try:
        if not sys.stdin.isatty() or not sys.stdout.isatty():raise ValueError('an interactive terminal is required for a recovery decision')
        if not args.id.strip() or len(args.id)>128 or not all(32<=ord(c)<=126 for c in args.id):raise ValueError('operation ID must be 1..128 printable ASCII characters')
        state=edit.private_state(args.state);version=edit.etas_version();fd=os.open(state/'.nomo-session.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            edit.check_history_lock(fd);storage.prepare(state);edit.ensure_cache(ROOT)
            env={k:v for k,v in os.environ.items() if not k.startswith('ETAS_HOST_') and k not in ('MINIMAX_API_KEY','NOMO_QWEN_SERVER_API_KEY','NOMO_MODEL_REQUEST_DEADLINE_MS')}
            env.update(NOMO_SESSION_STATE=str(state),NOMO_ETAS_VERSION=version);overlay='config/etas-'+version.replace('.','')+'-official-compose.yaml'
            compose=['docker','compose','--env-file','/dev/null','--file',str(ROOT/'compose.yaml'),'--file',str(ROOT/overlay),'--file',str(ROOT/'config/etas-runtime-cache-compose.yaml'),'--file',str(ROOT/'config/nomo-read-session-compose.yaml')]
            def run(flow,*native_args):
                native=['python3','-B','/workspace/scripts/nomo-verified-etas.py','run','/workspace','--flow',flow,'--profile','nomo-read-session-status','--allow-effects']
                if native_args:native+=['--args',*native_args]
                command=[sys.executable,str(ROOT/'scripts/terminal-transport.py'),*compose,'run','--rm','--no-deps','--pull','never','--tty=false','--workdir','/session-state','dev',*native]
                return edit.run_owned(command,env)
            if run('read_session_status')!=0:return 1
            print('Abandon '+args.target+' for operation '+args.id+'? This records your decision only. Prior effects may have occurred; no rollback or retry is authorized.',flush=True)
            try:answer=input('Record abandon? [y/N] ').strip().lower()
            except EOFError:answer=''
            if answer not in ('y','yes'):print('No decision recorded.',flush=True);return 1
            return run('recovery_decision',args.target,args.id)
        finally:os.close(fd)
    except KeyboardInterrupt:
        print('\nNo decision confirmed; inspect recorded status before further action.',file=sys.stderr);return 130
    except (OSError,ValueError) as error:
        print('REFUSED '+str(error),file=sys.stderr);return 1

def main(argv=None):
    raw=list(sys.argv[1:] if argv is None else argv)
    if raw[:1]==['--recovery-decision']:return recovery_decision(raw[1:])
    raw=route_followup(raw)
    independent=raw[:1]==['--independent-check']
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--read-root',required=not independent);parser.add_argument('--root',required=True);parser.add_argument('--state',required=True)
    parser.add_argument('--id',required=True);parser.add_argument('--path',required=not independent);parser.add_argument('--allow',required=not independent);parser.add_argument('--once',required=not independent)
    parser.add_argument('--events-policy-dir',required=independent)
    parser.add_argument('--event-followup',action='store_true',help=argparse.SUPPRESS)
    parser.add_argument('--legacy-followup',action='store_true',help=argparse.SUPPRESS)
    parser.add_argument('--interactive-check',action='store_true',help=argparse.SUPPRESS)
    parser.add_argument('--check',nargs=argparse.REMAINDER,required=independent)
    args=parser.parse_args(raw[1:] if independent else raw)
    if independent:
        if args.read_root is not None or args.path is not None or args.allow is not None or args.once is not None or args.event_followup or args.legacy_followup or args.interactive_check:parser.error('independent check accepts no work options')
        args.read_root=args.root;args.interactive_check=True
    try:
        if args.event_followup and args.events_policy_dir is None:raise ValueError('event followup requires an event policy')
        if args.legacy_followup and args.events_policy_dir is not None:raise ValueError('legacy followup cannot use event policy')
        context,workspace,state,version=edit.history_work_roots(args,ROOT)
        policy=None;binding=None;literals=[]
        if args.events_policy_dir is not None:
            policy,policy_data,binding=policy_module.read_private(args.events_policy_dir)
            data=json.loads(policy_data)
            literals=data.get('literals') if isinstance(data,dict) else None
            if not isinstance(literals,list) or not all(isinstance(item,str) and item for item in literals):raise ValueError('invalid event policy literals')
            for item in (context,workspace,state):
                if policy==item or policy in item.parents or item in policy.parents:raise ValueError('event policy directory must not overlap state or workspace')
        overlay='config/etas-'+version.replace('.','')+'-official-compose.yaml'
        if not independent:edit.validate_history_work(args,workspace,48 if args.legacy_followup else 128)
        fd=os.open(state/'.nomo-session.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            edit.check_history_lock(fd)
            storage.prepare(state)
            env,compose=edit.history_environment(state,workspace,context,version,ROOT,overlay)
            check_ref=hashlib.sha256(json.dumps(args.check,ensure_ascii=True,separators=(',',':')).encode()).hexdigest() if args.check else None
            if policy is not None:env['NOMO_EVENT_POLICY_DIR']=str(policy)
            if not independent:
                runner=['python3','-B','/workspace/scripts/nomo-verified-etas.py'];flow='history_followup' if args.legacy_followup else 'history_work';profile='nomo-history-work'
                if policy is not None:
                    compose+=['--file',str(ROOT/'config/nomo-event-policy-work-compose.yaml')]
                    runner=['python3','-B','/workspace/scripts/nomo-event-policy.py','mount-bootstrap',binding]
                    flow='recoverable_history_followup' if args.event_followup else 'recoverable_history_work';profile='nomo-history-events-work'
                native=[*runner,'run','/workspace','--flow',flow,'--profile',profile,'--allow-effects',
                    '--args','--id',args.id,'--workspace','private-workspace','--path',args.path,'--once',args.once,'--allow',args.allow]
                if check_ref:native+=['--check-ref',check_ref]
                if policy is not None:native+=['--policy-binding',binding]
                command=[sys.executable,str(ROOT/'scripts/terminal-transport.py'),*compose,'run','--rm','--no-deps','--pull','never','--tty=true','--workdir','/session-state','dev',*native]
                print('Prior conversation is untrusted model context. Current read and edit roots are newly selected; no prior approval is reused.',flush=True)
                print('Context, task, history and file may be sent to MiniMax. A new preview and two confirmations are required.',flush=True)
                if policy is not None:print('Selected work and check facts are recorded; only supplied exact literals are filtered. Unknown secrets and live terminal output may remain.',flush=True)
                if args.event_followup:print('Followup uses the persisted session mode: normal mode reserves 7 calls, 286720 output tokens and 2811008 configured native tokens; high-input mode reserves 7 calls, 188416 output tokens and a 6000000 configured native-token run ledger. Existing records retain their original allowance; configured allowances are not measured provider usage.',flush=True)
                if args.legacy_followup:print('Additional reservation: up to 7 model calls and 47104 output tokens; together both work rounds reserve up to 14 calls and 94208 output tokens, plus chat.',flush=True)
                diagnostic=edit.RuntimeDiagnostic()
                code=edit.run_owned(command,env,diagnostic=diagnostic)
                if code!=0:
                    diagnostic.report(code)
                    print('Work stopped. Inspect the edit and durable state before any further action; the outcome may be uncertain.',file=sys.stderr,flush=True);return code
                if not args.check:
                    print('Edit completed; no check was requested.',flush=True);return 0
            check,check_env=edit.prepare_project_check(str(workspace),args.check,version=version,long_capture=policy is not None)
            internal_env=edit.without_model(env)
            offline=['docker','compose','--env-file','/dev/null','--file',str(ROOT/'compose.yaml'),
                '--file',str(ROOT/overlay),'--file',str(ROOT/'config/etas-runtime-cache-compose.yaml'),
                '--file',str(ROOT/'config/nomo-read-session-compose.yaml')]
            if policy is not None:offline+=['--file',str(ROOT/'config/nomo-event-policy-work-compose.yaml')]
            def checkpoint(action,*extra,input_data=None):
                if policy is None:
                    native_check=['python3','-B','/workspace/scripts/nomo-verified-etas.py','run','/workspace','--flow','history_followup_check' if args.legacy_followup else 'history_check',
                        '--profile','nomo-read-session-status','--allow-effects','--args',action,args.id,check_ref,*extra]
                else:
                    check_flow='recoverable_history_followup_check' if args.event_followup else 'recoverable_history_check'
                    native_check=['python3','-B','/workspace/scripts/nomo-event-policy.py','mount-bootstrap',binding,'run','/workspace','--flow',check_flow,
                        '--profile','nomo-read-events-status','--allow-effects','--args','--policy-binding',binding,action,args.id,check_ref,*extra]
                command_check=[sys.executable,str(ROOT/'scripts/terminal-transport.py'),*offline,'run','--rm','--no-deps','--pull','never',
                    '--tty=false','--workdir','/session-state','dev',*native_check]
                return edit.run_owned(command_check,internal_env,input_data=input_data)
            if not independent and checkpoint('start'):
                print('Check was not started; inspect recorded status.',file=sys.stderr,flush=True);return 1
            print('Running the requested check offline (60-second limit; stdin is closed).' + (' Filtered output may be sent to the model.' if independent else ''),flush=True)
            capture={key:{'data':bytearray(),'truncated':False} for key in ('stdout','stderr')}
            code=edit.run_owned(check,check_env,capture,capture_limit=4194304 if policy is not None else 4096,forward_output=policy is None)
            if policy is not None and (0 <= code < 124 or code == 127):
                stdout,out_truncated=edit.format_check_capture(capture['stdout'],os.environ,literals,True)
                stderr,err_truncated=edit.format_check_capture(capture['stderr'],os.environ,literals,True)
                for name,value in (('stdout',stdout),('stderr',stderr)):
                    if value:print('Check '+name+':\n'+value,flush=True)
                print('Complete captured streams are filtered before saving up to 4096 UTF-8 bytes, with the middle omitted when necessary; incomplete streams are omitted and marked truncated.' if code != 127 else 'Filtered check output is shown for diagnosis only; the result is uncertain and was not recorded.',flush=True)
            if code<0 or code>=124:
                print('Check outcome is uncertain; ' + ('no result was recorded' if independent else 'recorded running state is retained') + ', without retry.',file=sys.stderr,flush=True);return code or 1
            outcome='passed' if code==0 else 'failed'
            if policy is not None:
                payload=(json.dumps([stdout,stderr],ensure_ascii=True)+'\n').encode()
                if checkpoint('independent' if independent else 'finish',outcome,str(code),str(out_truncated).lower(),str(err_truncated).lower(),input_data=payload):
                    print('Check finished but its result and selected output were not confirmed in session state.',file=sys.stderr,flush=True);return 1
            else:
                if checkpoint('finish',outcome,str(code)):
                    print('Check finished but its outcome was not confirmed in session state.',file=sys.stderr,flush=True);return 1
                stdout=edit.format_check_capture(capture['stdout'],os.environ);stderr=edit.format_check_capture(capture['stderr'],os.environ)
                if checkpoint('output',str(capture['stdout']['truncated']).lower(),str(capture['stderr']['truncated']).lower(),input_data=(json.dumps([stdout,stderr],ensure_ascii=True)+'\n').encode()):
                    print('Check completed but its diagnostic output was not recorded.',file=sys.stderr,flush=True);return 1
            if code:
                print('Check failed (exit '+str(code)+'); ask for a fix or inspect status.',file=sys.stderr,flush=True);return 0 if args.interactive_check else code
            print('Check passed.',flush=True);return 0
        finally:os.close(fd)
    except (OSError,ValueError) as error:
        print('REFUSED '+str(error),file=sys.stderr);return 1
if __name__=='__main__':
    from nomo_terminal import install
    install()
    raise SystemExit(main())
