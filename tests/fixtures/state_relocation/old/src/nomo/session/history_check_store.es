module nomo.session.history_check_store;



public type Record = {
    format: i32,
    phase: string,
    id: string,
    digest: string,
    outcome: string,
    exit_code: string
};
