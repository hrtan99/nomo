module nomo.native.history;

public import nomo.domain.conversation.messages.ChatMessage;

public effect SessionContext { action current() -> string; }

public type PendingRequest = { call: i64, name: string, complete: bool };
public type CopyJob = { id: string, workspace: string, title: string, kind: string, source: string,
    digest: bytes, total: i64, cursor: i64, phase: string };
public type Ledger = { turns: i64, compactions: i64, tools: i64, generation_allowance: i64, context_bytes: usize };
public type Session = { id: string, workspace: string, title: string, next_event: i64,
    first_user: i64, summary_event: i64, summary_through: i64, pending: string, ledger: Ledger };
public type Event = { role: string, name: string, call: i64, chunks: usize, complete: bool };
