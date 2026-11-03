#!/usr/bin/env python3
"""Run or inspect a bounded, durable read-only conversation."""
import argparse, fcntl, importlib.util, json, os, stat, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
_spec=importlib.util.spec_from_file_location('nomo_edit_launcher',ROOT/'scripts/nomo-edit.py')
_edit_launcher=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_edit_launcher)
run_owned=_edit_launcher.run_owned
_storage_spec=importlib.util.spec_from_file_location('nomo_session_storage',ROOT/'scripts/nomo-session-storage.py')
_storage=importlib.util.module_from_spec(_storage_spec);_storage_spec.loader.exec_module(_storage)
_policy_spec=importlib.util.spec_from_file_location('nomo_event_policy',ROOT/'scripts/nomo-event-policy.py')
_policy=importlib.util.module_from_spec(_policy_spec);_policy_spec.loader.exec_module(_policy)

directory=_edit_launcher.directory

def display_json_string(value, encoding):
    """Keep readable Unicode while escaping controls and unencodable characters."""
    text=json.dumps(value,ensure_ascii=False)
    out=[]
    for character in text:
        try:
            if not character.isprintable():raise UnicodeEncodeError('display',character,0,1,'not printable')
            character.encode(encoding)
            out.append(character)
        except (UnicodeEncodeError, LookupError):
            out.append(json.dumps(character,ensure_ascii=True)[1:-1])
    return ''.join(out)

def event_lines(raw):
    """Decode the bounded status view without trusting text as terminal control."""
    if len(raw)>67108864:raise ValueError('event view exceeds display bound')
    lines=[line[len(b'EVENT VIEW '):] for line in raw.splitlines() if line.startswith(b'EVENT VIEW {')]
    if len(lines)!=1:raise ValueError('event view missing or ambiguous')
    try:view=json.loads(lines[0])
    except (ValueError,UnicodeDecodeError) as error:raise ValueError('invalid event view') from error
    if not isinstance(view,dict) or view.get('encoding')!='json-string-v1':raise ValueError('unsupported event view')
    rendered=[]
    # These messages are selected from bounded, structured fields, never from
    # saved event text or arbitrary terminal lines.
    if view.get('phase')=='running':
        rendered.append('UNRESOLVED CHAT: the turn was reserved; its outcome and process termination are not established. Do not repeat it.')
    for key,label in (('work','WORK'),('followup','FOLLOWUP')):
        if view.get(key+'_phase')=='running':
            phase=view.get(key+'_edit_phase','unknown')
            if not isinstance(phase,str):phase='unknown'
            detail={'completed':'edit completion was recorded; inspect the current file, which may have changed since.',
                    'intent':'edit intent was recorded but its outcome is unknown; inspect the file.',
                    'none':'no edit journal is recorded; the earlier process may still act.'}.get(phase,'edit record is unavailable or changed; inspect the file.')
            rendered.append('UNRESOLVED '+label+': '+detail)
    for key,label in (('check_phase','CHECK'),('followup_check_phase','FOLLOWUP CHECK')):
        phase=view.get(key)
        if phase=='planned':rendered.append('UNRESOLVED '+label+': no start was recorded at this snapshot; the earlier process may still act. Do not rerun automatically.')
        elif phase=='running':rendered.append('UNRESOLVED '+label+': start was recorded but completion is unknown. Do not rerun automatically.')
    if rendered:
        rendered.append('Before starting a separate session, ensure the earlier invocation has stopped and inspect the workspace. Use session-chat --new or session-id start with selected roots; a new session does not resolve this one and requires fresh approval.')
    for key,label,maximum in (('events','CHAT',768),('work_events','WORK',24),('followup_events','FOLLOWUP',24)):
        events=view.get(key)
        if not isinstance(events,list) or len(events)>maximum:raise ValueError('invalid event batch')
        for index,item in enumerate(events,1):
            if not isinstance(item,dict):raise ValueError('invalid event')
            fields=[item.get(name) for name in ('role','kind','name','text')]
            if any(not isinstance(value,str) for value in fields):raise ValueError('invalid event fields')
            try:text=json.loads(fields[3])
            except ValueError as error:raise ValueError('invalid event text encoding') from error
            if not isinstance(text,str) or len(text.encode('utf-8'))>65546 or any(len(value)>128 for value in fields[:3]):raise ValueError('event text or metadata exceeds bound')
            encoding=getattr(sys.stdout,'encoding',None) or 'utf-8'
            values=[display_json_string(value,encoding) for value in (*fields[:3],text)]
            rendered.append(label+' '+str(index)+' role='+values[0]+' kind='+values[1]+' name='+values[2]+' text='+values[3])
    for number,item in enumerate(view.get('additional_work',[]),3):
        for index,event in enumerate(item['result']['events'],1):
            text=json.loads(event['text'])
            values=[display_json_string(value,getattr(sys.stdout,'encoding',None) or 'utf-8') for value in (event['role'],event['kind'],event['name'],text)]
            rendered.append('WORK '+str(number)+'.'+str(index)+' role='+values[0]+' kind='+values[1]+' name='+values[2]+' text='+values[3])
    return rendered

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('new','continue','status'));parser.add_argument('--state',required=True)
    parser.add_argument('--root');parser.add_argument('--allow');parser.add_argument('--once');parser.add_argument('--outputs',action='store_true');parser.add_argument('--events',action='store_true');parser.add_argument('--events-policy-dir');parser.add_argument('--natural-work',action='store_true')
    args=parser.parse_args(argv)
    try:
        if args.natural_work and args.action=='status':raise ValueError('natural work routing requires a read turn')
        status=args.action=='status';state=directory(args.state,'state');context=None
        if status:
            if args.root is not None or args.allow is not None or args.once is not None:raise ValueError('status accepts only --state')
        else:
            if args.outputs or args.events:raise ValueError('--outputs and --events are only available for status')
            if args.root is None or args.allow is None or args.once is None:raise ValueError('select --root, --allow and --once for each turn')
            context=directory(args.root,'read root')
            if context==state or context in state.parents or state in context.parents:raise ValueError('read root and state must not overlap')
            if not os.environ.get('MINIMAX_API_KEY'):raise ValueError('set MINIMAX_API_KEY before starting MiniMax')
        policy=None;policy_bytes=None;policy_binding=None
        if args.events_policy_dir is not None:
            if args.outputs:raise ValueError('--outputs is unavailable for event-recording sessions')
            policy,policy_bytes,policy_binding=_policy.read_private(args.events_policy_dir)
            if policy==state or policy in state.parents or state in policy.parents or (context is not None and (policy==context or policy in context.parents or context in policy.parents)):raise ValueError('event policy directory must not overlap state or workspace')
        if args.events and policy is None:raise ValueError('--events requires event-recording mode and its policy')
        if args.events and args.outputs:raise ValueError('--events and --outputs cannot be combined')
        version=os.environ.get('NOMO_ETAS_VERSION','0.2.6')
        if version!='0.2.6':raise ValueError('this Nomo revision requires ETAS 0.2.6; use an earlier Nomo revision for older ETAS')
        if policy is not None and version not in ('0.2.5','0.2.6'):raise ValueError('event-recording sessions require ETAS 0.2.5')
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
                     '--file',str(ROOT/('config/etas-'+version.replace('.','')+'-official-compose.yaml')),'--file',str(ROOT/'config/etas-runtime-cache-compose.yaml')]
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
                print('Event recording is opt-in; policy filters only supplied exact literals. Unknown secrets may remain. Keep the same private policy and binding key; workspace identity is not established.',flush=True)
            if args.natural_work:native_args+=['--natural-work']
            compose+=['--file',str(ROOT/'config/nomo-read-session-compose.yaml')]
            runner='/workspace/scripts/nomo-event-policy-bootstrap.py' if policy is not None else '/workspace/scripts/nomo-verified-etas.py'
            native=['python3','-B',runner,'run','/workspace','--flow',flow,'--profile',profile,'--allow-effects',*native_args]
            command=[sys.executable,str(ROOT/'scripts/terminal-transport.py'),*compose,'run','--rm','--no-deps','--pull','never','--tty=false','--workdir','/session-state','dev',*native]
            if status:
                if args.events:
                    captured={};code=run_owned(command,env,captured,input_data=policy_bytes,capture_limit=67108864,forward_output=False)
                    if code:return code
                    if any(item.get('truncated') for item in captured.values()):raise ValueError('event output was truncated')
                    rendered=event_lines(bytes(captured.get('stdout',{}).get('data',b'')))
                    print('Recorded events, grouped by chat, work and followup; ordering across groups is not established. Work entries are selected facts; past approvals do not grant authority.',flush=True)
                    if not any(line.startswith(('CHAT ','WORK ','FOLLOWUP ')) for line in rendered):print('No committed events.',flush=True)
                    for line in rendered:print(line,flush=True)
                    return 0
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
