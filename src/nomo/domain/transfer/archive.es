module nomo.domain.transfer.archive;

import std.json.JsonValue;
import nomo.domain.conversation.messages.ChatMessage;
import nomo.native.history.{Session, CopyJob};
import nomo.native.lifecycle.Attempt;

public type PortableInfo = { id: string, workspace: string, title: string, metadata: string };
public type PortableArchive = { format: string, session: PortableInfo, events: Array<ChatMessage> };
public type LegacyInfo = { id: string, root: string, title: string, created: f64, updated: f64,
    parent: JsonValue, compacted_through: i64, summary: string, usage: string };
public type LegacyEvent = { id: i64, session: string, role: string, kind: string, name: string,
    content: string, data: JsonValue, created: f64 };
public type LegacyArchive = { format: string, session: LegacyInfo, events: Array<LegacyEvent> };
public type ExportPreview = { path: string, content: string };
public type ExportOutcome = { path: string, status: string };
public type ExportMetadata = { format: string, conversation: Session, attempts: Array<Attempt>, copies: Array<CopyJob> };

public type Imported = { title: string, events: Array<ChatMessage>, summary: string };

public enum ArchiveDocument { Metadata(ExportMetadata), Conversation(PortableArchive), Outcome(ExportOutcome) }
