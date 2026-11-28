module nomo.session.work_record;

import nomo.session.edit_operation.Binding;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

public type Record = {
    format: i32,
    phase: string,
    binding: Binding,
    body: string
};
