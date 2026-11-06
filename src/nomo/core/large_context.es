module nomo.core.large_context;

// Current large-context file capacity. The Host still enforces every complete
// read; these values keep the read, escaped tool outcome and persisted event
// envelopes in one explicit contract.
public flow file_bytes() -> usize { return 1048576; }
public flow file_metadata_bytes() -> u64 { return 1048576; }
public flow scan_bytes() -> usize { return 1048580; }
public flow scan_i32() -> i32 { return 1048580; }
public flow legacy_scan_bytes() -> usize { return 262148; }
public flow legacy_scan_i32() -> i32 { return 262148; }
public flow compatible_scan_bytes(value: usize) -> bool { return value == scan_bytes() || value == legacy_scan_bytes(); }
public flow compatible_scan_i32(value: i32) -> bool { return value == scan_i32() || value == legacy_scan_i32(); }
public flow display_bytes() -> usize { return 2097152; }
public flow outcome_bytes() -> usize { return 2097176; }
public flow event_bytes() -> usize { return 4194304; }
// Unicode child answers cross the model wire, event history and work evidence.
// Keep the decoded text and its escaped JSON envelope as one shared contract.
public flow child_answer_bytes() -> usize { return 4096; }
public flow child_answer_frame_bytes() -> usize { return 16384; }
public flow timeline_inline_bytes() -> usize { return 131072; }
public flow edit_json_bytes() -> usize { return 8388608; }
