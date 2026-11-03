#!/usr/bin/env python3
"""Record an explicit decision to abandon an unresolved operation."""
import argparse,fcntl,importlib.util,os,stat,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('edit_launcher',ROOT/'scripts/nomo-edit.py');edit=importlib.util.module_from_spec(spec);spec.loader.exec_module(edit)
storage_spec=importlib.util.spec_from_file_location('nomo_session_storage',ROOT/'scripts/nomo-session-storage.py');storage=importlib.util.module_from_spec(storage_spec);storage_spec.loader.exec_module(storage)
def main(argv=None):
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--state',required=True);parser.add_argument('--id',required=True);parser.add_argument('--target',choices=('work','check','followup','followup-check'),required=True);args=parser.parse_args(argv)
 try:
  if not sys.stdin.isatty() or not sys.stdout.isatty():raise ValueError('an interactive terminal is required for a recovery decision')
  if not args.id.strip() or len(args.id)>128 or not all(32<=ord(c)<=126 for c in args.id):raise ValueError('operation ID must be 1..128 printable ASCII characters')
  state=edit.directory(args.state,'state');st=state.stat()
  if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise ValueError('state must be owned by you with mode 0700')
  version=os.environ.get('NOMO_ETAS_VERSION','0.2.5')
  if version not in ('0.2.4','0.2.5'):raise ValueError('recovery decision requires ETAS 0.2.4 or 0.2.5')
  fd=os.open(state/'.nomo-session.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
  try:
   info=os.fstat(fd)
   if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600:raise ValueError('session lock must be a private regular file')
   try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:raise ValueError('session already in use')
   storage.prepare(state)
   cache=ROOT/'.etas'
   if cache.is_symlink():raise ValueError('project .etas mountpoint must not be a symlink')
   cache.mkdir(mode=0o700,exist_ok=True)
   if cache.is_symlink() or not cache.is_dir():raise ValueError('project .etas mountpoint must be a directory')
   env={k:v for k,v in os.environ.items() if not k.startswith('ETAS_HOST_') and k not in ('MINIMAX_API_KEY','NOMO_QWEN_SERVER_API_KEY','NOMO_MODEL_REQUEST_DEADLINE_MS')}
   env.update(NOMO_SESSION_STATE=str(state),NOMO_ETAS_VERSION=version)
   overlay='config/etas-025-official-compose.yaml' if version=='0.2.5' else 'config/etas-024-official-compose.yaml'
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
if __name__=='__main__':raise SystemExit(main())
