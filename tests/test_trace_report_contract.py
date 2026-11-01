"""Selector/report mismatches must fail before Host evidence is interpreted."""
import os
import unittest
from unittest.mock import patch

from tests.trace_report_contract import validate_report


class TraceReportContract(unittest.TestCase):
    def report(self, schema, outcome='completed', settled=True):
        return {'schema': schema, 'outcome': {'kind': outcome},
                'termination': {'local_work_settled': settled}, 'events': []}

    def test_version_follows_explicit_selector(self):
        for selected, accepted, refused in [('latest022', 'v2', 'v1'), ('latest012', 'v1', 'v2'), ('latest', 'v1', 'v2')]:
            with self.subTest(selected=selected), patch.dict(os.environ, {'NOMO_NORMAL_GRAPH': selected}):
                prefix = 'etas.cli.interpreter-report.'
                self.assertEqual(validate_report(self.report(prefix + accepted), True)['schema'], prefix + accepted)
                with self.assertRaises(AssertionError):
                    validate_report(self.report(prefix + refused), True)

    def test_incomplete_or_wrong_outcome_is_rejected(self):
        with patch.dict(os.environ, {'NOMO_NORMAL_GRAPH': 'latest022'}):
            for report in [self.report('etas.cli.interpreter-report.v2', 'failed'),
                           self.report('etas.cli.interpreter-report.v2', settled=False),
                           dict(self.report('etas.cli.interpreter-report.v2'), incomplete=True)]:
                with self.subTest(report=report), self.assertRaises(AssertionError):
                    validate_report(report, True)

    def test_unknown_selector_is_rejected(self):
        with patch.dict(os.environ, {'NOMO_NORMAL_GRAPH': 'unrecorded'}), self.assertRaises(RuntimeError):
            validate_report(self.report('etas.cli.interpreter-report.v2'), True)


if __name__ == '__main__':
    unittest.main()
