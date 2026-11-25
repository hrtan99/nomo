module nomo.application.native.configuration.context;

import nomo.domain.configuration.settings.Settings;

public effect SettingsContext { action current() -> Settings; }
