module nomo.domain.sessions.checks;

import nomo.domain.sessions.facts.CheckOutput;

public type CheckResult = { outcome: string, exit_code: string, stdout: string, stderr: string, stdout_truncated: bool, stderr_truncated: bool };

public type CheckFacts = { id: string, digest: string, phase: string, outcome: string, exit_code: string, output: Option<CheckOutput> };
