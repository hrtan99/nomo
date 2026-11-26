module nomo.bootstrap.recoverable_status;

import nomo.domain.sessions.redaction.Policy;
import nomo.adapters.storage.recoverable_status.RecoverableSessionStatusReader;

public flow recoverable_status_reader(redaction: Policy, binding: string) -> RecoverableSessionStatusReader {
    return RecoverableSessionStatusReader { redaction, binding };
}
