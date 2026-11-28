module nomo.application.resources;

import std.fs.Region;

public type MigrationRoot;

impl MigrationRoot ~ Region;

public type LaunchRoot;

impl LaunchRoot ~ Region;

public type ProjectRoot;

impl ProjectRoot ~ Region;

public type PolicyRoot;

impl PolicyRoot ~ Region;

public type EditableRoot;

impl EditableRoot ~ Region;

public type ReadOnlyRoot;

impl ReadOnlyRoot ~ Region;
