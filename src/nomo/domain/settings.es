module nomo.domain.settings;

import std.text.{from_i64, from_usize, parse_f64, parse_usize};

public type Settings = {
    context_window: i64,
    max_output_tokens: i64,
    compact_ratio: f64,
    keep_messages: i64,
    command_timeout: i64,
    ignore: Array<string>,
    instructions: Array<string>,
    check: Array<string>
};

public flow defaults() -> Settings {
    return Settings {
        context_window = 1048576,
        max_output_tokens = 131072,
        compact_ratio = 0.75,
        keep_messages = 12,
        command_timeout = 600,
        ignore = [],
        instructions = [],
        check = []
    };
}

public flow with_check(settings: Settings, override: Option<Array<string>>) -> Settings {
    let check = match override {
        Some(value) => value,
        None() => {
            return settings;
        }
    };
    return settings {
        check
    };
}

public flow validate(settings: Settings) -> Settings {
    if settings.max_output_tokens < 1 || settings.max_output_tokens > 131072
        || settings.context_window <= settings.max_output_tokens {
        abort("context_window must exceed max_output_tokens (1..131072)");
    }
    if settings.compact_ratio <= 0.0 || settings.compact_ratio >= 1.0 || settings.keep_messages < 0 {
        abort("compact_ratio must be between zero and one; keep_messages must be nonnegative");
    }
    return settings;
}

public flow effective_window(settings: Settings) -> i64 {
    return if settings.context_window > 1048576 {
        1048576
    } else {
        settings.context_window
    };
}

public flow as_number(value: i64) -> f64 {
    return match parse_f64(from_i64(value)) {
        Ok(value) => value,
        Err(_) => abort("context number conversion failed"),
    };
}

public flow estimated_tokens(bytes: usize) -> f64 {
    return match parse_f64(from_usize((bytes + 2) / 3)) {
        Ok(value) => value,
        Err(_) => abort("context estimate conversion failed"),
    };
}

public flow recent_bytes(settings: Settings) -> usize {
    let available = (effective_window(settings) - settings.max_output_tokens) * 3 / 2;
    let budget = if available < 393216 {
        available
    } else {
        393216
    };
    return match parse_usize(from_i64(budget)) {
        Ok(value) => value,
        Err(_) => abort("recent history budget conversion failed"),
    };
}

public type ConfigurationStatus = {
    requested: Settings,
    effective_context_window: i64,
    context_window_is_estimate: bool,
    inference_token_allowance: i64,
    summary_token_allowance: i64,
    runtime_output_tokens: i64,
    command_timeout_active: bool
};

public flow status(settings: Settings) -> ConfigurationStatus {
    return ConfigurationStatus {
        requested = settings,
        effective_context_window = effective_window(settings),
        context_window_is_estimate = true,
        inference_token_allowance = 536870912,
        summary_token_allowance = 1048576,
        runtime_output_tokens = 131072,
        command_timeout_active = false
    };
}
