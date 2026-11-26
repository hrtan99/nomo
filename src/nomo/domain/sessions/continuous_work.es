module nomo.domain.sessions.continuous_work;

import std.memory.MemoryVersion;
import nomo.session.continuous_work.Book;

public type Stored = { key: string, value: Book, version: MemoryVersion };
