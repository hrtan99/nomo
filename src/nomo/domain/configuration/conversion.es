module nomo.domain.configuration.conversion;

// Views of existing saved command observations; no new stored representation.
public type ConfigurationOutput = { exit_code: i32, stdout: string, stderr: string };
public type Converted = { result_event: i64, output: ConfigurationOutput };
public type CacheReference = { digest: bytes, session: string, result_event: i64 };
