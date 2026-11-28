module nomo.session.work_record;

import nomo.session.edit_operation.Binding;

public type Record = {
    format: i32,
    phase: string,
    binding: Binding,
    body: string
};
