import contextlib,importlib.util,io,sys,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('followup',ROOT/'scripts/nomo-history-followup.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class EventFollowupRoute(unittest.TestCase):
 def test_event_policy_delegates_before_check_arguments(self):
  spec2=importlib.util.spec_from_file_location('work',ROOT/'scripts/nomo-history-work.py');work=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(work)
  with patch.object(module.importlib.util,'module_from_spec',return_value=work),patch.object(spec2.loader,'exec_module'),patch.object(work,'main',return_value=9) as invoke:
   # Loader instance is selected dynamically; use a shared synthetic spec.
   with patch.object(module.importlib.util,'spec_from_file_location',return_value=spec2):
    self.assertEqual(module.main(['--events-policy-dir=/safe','--check','true']),9)
   self.assertEqual(invoke.call_args.args[0],['--event-followup','--events-policy-dir=/safe','--check','true'])
 def test_check_argument_named_policy_does_not_change_route(self):
  with patch.object(module.sys,'stdin',io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
   # It reaches the legacy parser and then refuses non-TTY; no event delegate.
   self.assertEqual(module.main(['--read-root','/r','--root','/w','--state','/s','--id','i','--path','p','--allow','x','--once','t','--check','printf','--events-policy-dir']),1)
if __name__=='__main__':unittest.main()
