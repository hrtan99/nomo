module nomo.core.large_context;

// Current large-context file capacity. The Host still enforces every complete
// read; these values keep the read, escaped tool outcome and persisted event
// envelopes in one explicit contract.
public flow file_bytes() -> usize { return 262144; }
public flow file_metadata_bytes() -> u64 { return 262144; }
public flow scan_bytes() -> usize { return 262148; }
public flow scan_i32() -> i32 { return 262148; }
public flow display_bytes() -> usize { return 524288; }
public flow outcome_bytes() -> usize { return 524312; }
public flow event_bytes() -> usize { return 1048576; }
public flow timeline_inline_bytes() -> usize { return 131072; }
public flow edit_json_bytes() -> usize { return 8388608; }
