module nomo.bootstrap.work;

import std.memory.MemoryEntry;
import nomo.session.recoverable_chat_store.Frame as ChatFrame;
import nomo.adapters.filesystem.work_editor.NativeWorkEditor;
import nomo.adapters.storage.work_timeline.EventWorkTimeline;

public flow native_editor() -> NativeWorkEditor { return NativeWorkEditor {}; }
public flow event_timeline(chat: MemoryEntry<string, ChatFrame>) -> EventWorkTimeline { return EventWorkTimeline { chat }; }
