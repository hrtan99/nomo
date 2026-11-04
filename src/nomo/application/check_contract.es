module nomo.application.check_contract;

import nomo.application.history_contract.CheckOutput;

public type CheckResult = { outcome: string, exit_code: string, stdout: string, stderr: string, stdout_truncated: bool, stderr_truncated: bool };
public type CheckFacts = { id: string, digest: string, phase: string, outcome: string, exit_code: string, output: Option<CheckOutput> };
public spec CheckFactsReader {
    flow read(self) -> Result<Option<CheckFacts>, string> ![Memory, Error<StorageError>, Error<IndexError>];
}
public spec CheckLifecycle {
    flow start(self, id: string, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow finish(self, id: string, digest: string, result: CheckResult) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow abandon(self, id: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
}
