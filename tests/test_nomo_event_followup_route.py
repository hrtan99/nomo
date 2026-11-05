import importlib.util,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('followup',ROOT/'scripts/nomo-history-work.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class EventFollowupRoute(unittest.TestCase):
 def test_event_policy_delegates_before_check_arguments(self):
  self.assertEqual(module.route_followup(['--followup','--events-policy-dir=/safe','--check','true']),['--event-followup','--events-policy-dir=/safe','--check','true'])
 def test_check_argument_named_policy_does_not_change_route(self):
  self.assertEqual(module.route_followup(['--followup','--check','printf','--events-policy-dir']),['--legacy-followup','--check','printf','--events-policy-dir'])
if __name__=='__main__':unittest.main()
