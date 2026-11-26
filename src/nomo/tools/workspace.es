module nomo.tools.workspace;

import std.fs.Region;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

public type ReadOnlyRoot;

impl ReadOnlyRoot ~ Region;
