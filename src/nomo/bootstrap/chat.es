module nomo.bootstrap.chat;

import std.memory.MemoryEntry;
import nomo.application.chat.controller.ChatRepository;
import nomo.harness.harness_tool_chat_contract.TurnResult;
import nomo.session.chat_history.{Entry as LegacyEntry, load as load_legacy, save as save_legacy, save_completed};
import nomo.session.chat_session_contract.{fresh, begin, complete};
import nomo.session.recoverable_chat_store.{Frame, load as load_recoverable, create as create_recoverable, reserve as reserve_recoverable, finish as finish_recoverable, matches_version};
import nomo.session.redaction.Policy;

public type LegacyChatRepository = {};
impl LegacyChatRepository ~ ChatRepository<LegacyEntry> {
    flow load(self) -> Result<Option<LegacyEntry>, string> { return load_legacy(); }
    flow create(self) -> Result<LegacyEntry, string> {
        let version = match save_legacy(fresh(), None()) { Ok(value) => value, Err(error) => { return Err(error); } };
        let saved = match load_legacy() { Ok(Some(value)) => value, _ => { return Err("session missing or invalid"); } };
        if saved.version.opaque != version.opaque || saved.value != fresh() { return Err("session creation changed"); }
        return Ok(saved);
    }
    flow reserve(self, current: LegacyEntry, request: string) -> Result<LegacyEntry, string> {
        if current.pending { return Err("event history pending; inspect without retry"); }
        let running = match begin(current.value, request) { Ok(value) => value, Err(error) => { return Err(error); } };
        let version = match save_legacy(running, Some(current)) { Ok(value) => value, Err(error) => { return Err(error); } };
        let saved = match load_legacy() { Ok(Some(value)) => value, _ => { return Err("reservation missing"); } };
        if saved.value != running || saved.version.opaque != version.opaque { return Err("reservation changed"); }
        return Ok(saved);
    }
    flow verified(self, ticket: LegacyEntry) -> Result<bool, string> {
        return match load_legacy() { Ok(Some(value)) => Ok(value == ticket), Ok(None()) => Ok(false), Err(error) => Err(error) };
    }
    flow finish(self, ticket: LegacyEntry, result: TurnResult) -> Result<bool, string> {
        let next = match complete(ticket.value, result) { Ok(value) => value, Err(error) => { return Err(error); } };
        let completed = match result.completed { Some(value) => value, None() => { return Err("completed event batch missing"); } };
        return match save_completed(next, Some(ticket), completed.records) { Ok(_) => Ok(true), Err(error) => Err(error) };
    }
    flow exists_error(self) -> string ![] { return "session already exists"; }
    flow missing_error(self) -> string ![] { return "session missing"; }
    flow unresolved_error(self) -> string ![] { return "chat turn unresolved; inspect session, do not retry"; }
}

public alias RecoverableTicket = MemoryEntry<string, Frame>;
public type RecoverableChatRepository = { redaction: Policy, binding: string, high_input: bool };
impl RecoverableChatRepository ~ ChatRepository<RecoverableTicket> {
    flow load(self) -> Result<Option<RecoverableTicket>, string> { return load_recoverable(self.redaction, self.binding); }
    flow create(self) -> Result<RecoverableTicket, string> {
        return create_recoverable(self.redaction, self.binding, self.high_input);
    }
    flow reserve(self, current: RecoverableTicket, request: string) -> Result<RecoverableTicket, string> {
        let saved = match reserve_recoverable(current, request, self.redaction, self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        if saved.value.chat.phase != "running" { return Err("reservation changed"); }
        return Ok(saved);
    }
    flow verified(self, ticket: RecoverableTicket) -> Result<bool, string> {
        return matches_version(ticket.version);
    }
    flow finish(self, ticket: RecoverableTicket, result: TurnResult) -> Result<bool, string> {
        return match finish_recoverable(ticket, result, self.redaction, self.binding) { Ok(_) => Ok(true), Err(error) => Err(error) };
    }
    flow exists_error(self) -> string ![] { return "session already exists"; }
    flow missing_error(self) -> string ![] { return "recoverable session missing"; }
    flow unresolved_error(self) -> string ![] { return "chat turn unresolved; inspect without retry"; }
}

public flow legacy_repository() -> LegacyChatRepository { return LegacyChatRepository {}; }
public flow recoverable_repository(redaction: Policy, binding: string, high_input: bool) -> RecoverableChatRepository {
    return RecoverableChatRepository { redaction = redaction, binding = binding, high_input = high_input };
}
