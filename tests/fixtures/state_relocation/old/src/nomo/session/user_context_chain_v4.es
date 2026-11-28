module nomo.session.user_context_chain_v4;

import nomo.session.work_chain.Record as BaseRecord;

public type RootIdentity = {
    version: i32,
    authority: string,
    token: string
};

public type Record = {
    format: i32,
    root: RootIdentity,
    parent_proof: string,
    base: BaseRecord
};
