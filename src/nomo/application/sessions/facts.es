module nomo.application.sessions.facts;

import nomo.domain.sessions.facts.Facts;

public spec WorkFactsReader {
    flow snapshot(self) -> Result<Facts, string> ![Memory, Error<StorageError>, Error<IndexError>];
}
