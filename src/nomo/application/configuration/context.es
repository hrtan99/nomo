module nomo.application.configuration.context;

import nomo.domain.configuration.settings.Settings;

public effect SettingsContext { action current() -> Settings; }
