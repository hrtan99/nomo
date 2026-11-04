module nomo.entry.history_followup_check;

import nomo.entry.history_check.run_slot;

// Internal launcher boundary; the caller holds the session lock.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>] { return run_slot(args, true); }
