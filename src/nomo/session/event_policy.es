module nomo.session.event_policy;

import std.fs.Region;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

public type PolicyRoot;

impl PolicyRoot ~ Region;
