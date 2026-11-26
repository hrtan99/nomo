module nomo.session.check_store;

import nomo.session.history_check_store.Record;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

public type Frame = { format: i32, policy_binding: string, work_history: string, workspace: string, path: string,
    check: Record, stdout: string, stderr: string, stdout_truncated: bool, stderr_truncated: bool };
