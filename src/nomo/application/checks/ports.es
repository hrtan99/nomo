module nomo.application.checks.ports;

import nomo.domain.sessions.checks.{CheckResult, CheckFacts};

public spec CheckFactsReader {
    flow read(self) -> Result<Option<CheckFacts>, string> ![Memory, Error<StorageError>, Error<IndexError>];
}

public spec CheckLifecycle {
    flow start(self, id: string, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow finish(self, id: string, digest: string, result: CheckResult) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow abandon(self, id: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
}
