module nomo.domain.configuration.conversion;

public import nomo.native.configuration.Cached as CacheReference;

// Views of existing saved command observations; no new stored representation.
public type ConfigurationOutput = { exit_code: i32, stdout: string, stderr: string };
public type Converted = { result_event: i64, output: ConfigurationOutput };
