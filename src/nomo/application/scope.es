module nomo.application.scope;

import nomo.domain.settings.Settings;

public effect SettingsContext {
    action current() -> Settings;
}

public effect SessionContext {
    action current() -> string;
}
