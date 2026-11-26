module nomo.bootstrap.legacy_status;

import nomo.adapters.storage.legacy_status.LegacySessionStatusReader;

public flow legacy_status_reader() -> LegacySessionStatusReader { return LegacySessionStatusReader {}; }
