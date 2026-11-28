module nomo.session.edit_operation;



public type Binding = {
    id: string,
    workspace: string,
    region: string,
    path: string,
    request_digest: string,
    before_digest: string,
    after_digest: string,
    before_bytes: usize,
    after_bytes: usize
};

public type Record = {
    format: i32,
    phase: string,
    binding: Binding
};
