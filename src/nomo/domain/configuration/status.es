module nomo.domain.configuration.status;

import nomo.domain.configuration.settings.{Settings, effective_window};

public type ConfigurationStatus = { requested: Settings, effective_context_window: i64, context_window_is_estimate: bool,
    inference_token_allowance: i64, summary_token_allowance: i64, runtime_output_tokens: i64, command_timeout_active: bool };

public flow status(settings: Settings) -> ConfigurationStatus {
    return ConfigurationStatus { requested = settings, effective_context_window = effective_window(settings), context_window_is_estimate = true,
        inference_token_allowance = 536870912, summary_token_allowance = 1048576, runtime_output_tokens = 131072, command_timeout_active = false };
}
