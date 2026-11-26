module nomo.domain.sessions.harness_checkpoint_store;

import std.memory.MemoryVersion;
import nomo.domain.sessions.harness_checkpoint.Checkpoint;

public type Binding = { checkpoint: Checkpoint, version: MemoryVersion, body: string };
