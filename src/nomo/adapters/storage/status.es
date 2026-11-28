module nomo.adapters.storage.status;

import nomo.adapters.storage.chains.get;
import nomo.adapters.storage.chat.{chat_history_load, recoverable_chat_store_load};
import nomo.adapters.storage.checks.{inspect as checks_inspect, load};
import nomo.adapters.storage.edits.{edit_operation_store_inspect, history_followup_edit_store_inspect};
import nomo.adapters.storage.followup.{inspect as followup_inspect, load as followup_load};
import nomo.adapters.storage.followup_checks.{inspect as followup_checks_inspect, load as followup_checks_load};
import nomo.adapters.storage.work_admission.{Stored, continuous_work_load, inspect, recoverable_work_store_load};
import nomo.application.sessions.ports.{Entry, SessionStatusReader};
import nomo.domain.sessions.event_codec.Policy;
import nomo.session.check_store.Frame as check_store_Frame;
import nomo.session.edit_operation.Record as edit_operation_Record;
import nomo.session.history_check_store.Record as history_check_store_Record;
import nomo.session.history_followup_guard.Record as history_followup_guard_Record;
import nomo.session.history_work_guard.Record;
import nomo.session.recoverable_chat_store.Frame;
import nomo.session.recoverable_followup_store.Frame as recoverable_followup_store_Frame;
import nomo.session.recoverable_work_store.Frame as recoverable_work_store_Frame;
import nomo.session.recovery_decision.Decision;
import std.memory.MemoryEntry;

public type LegacyStatus = { chat: Entry, work: Option<Record>, work_edit: Option<edit_operation_Record>, check: Option<history_check_store_Record>,
    followup: Option<history_followup_guard_Record>, followup_edit: Option<edit_operation_Record>, followup_check: Option<history_check_store_Record>, decisions: Array<Decision> };

public type LegacySessionStatusReader = {};

impl LegacySessionStatusReader ~ SessionStatusReader<LegacyStatus> {
    flow snapshot(self) -> Result<LegacyStatus, string> {
        let chat = match chat_history_load() { Ok(Some(value)) => value, Ok(None()) => { return Err("SESSION missing"); } Err(error) => { return Err(error); } };
        let work = match inspect() { Ok(value) => value, Err(error) => { return Err(error); } };
        var work_edit: Option<edit_operation_Record> = None();
        match work { Some(value) => { work_edit = match edit_operation_store_inspect(value.id, value.workspace, value.path) { Ok(item) => item, Err(error) => { return Err(error); } }; } None() => (), }
        let check = match checks_inspect() { Ok(value) => value, Err(error) => { return Err(error); } };
        let followup = match followup_inspect() { Ok(value) => value, Err(error) => { return Err(error); } };
        var followup_edit: Option<edit_operation_Record> = None();
        match followup { Some(value) => { followup_edit = match history_followup_edit_store_inspect(value.id, value.workspace, value.path) { Ok(item) => item, Err(error) => { return Err(error); } }; } None() => (), }
        let followup_check = match followup_checks_inspect() { Ok(value) => value, Err(error) => { return Err(error); } };
        var decisions: Array<Decision> = [];
        @limits([Iterations(4)]) for target in ["work", "check", "followup", "followup-check"] {
            let decision = match get(target) { Ok(value) => value, Err(error) => { return Err(error); } };
            match decision { Some(value) => { decisions = decisions.push(value); } None() => (), }
        }
        return Ok(LegacyStatus { chat, work, work_edit, check,
            followup, followup_edit, followup_check, decisions });
    }
}

public alias ChatEntry = MemoryEntry<string, Frame>;

public alias WorkEntry = MemoryEntry<string, recoverable_work_store_Frame>;

public alias CheckEntry = MemoryEntry<string, check_store_Frame>;

public alias FollowupEntry = MemoryEntry<string, recoverable_followup_store_Frame>;

public alias Snapshot = { chat: ChatEntry, work: Option<WorkEntry>, check: Option<CheckEntry>,
    followup: Option<FollowupEntry>, followup_check: Option<CheckEntry>, additional: Option<Stored> };

public type RecoverableSessionStatusReader = { redaction: Policy, binding: string };

impl RecoverableSessionStatusReader ~ SessionStatusReader<Snapshot> {
    flow snapshot(self) -> Result<Snapshot, string> {
        let chat = match recoverable_chat_store_load(self.redaction, self.binding) { Ok(Some(value)) => value, Ok(None()) => { return Err("recoverable session missing"); } Err(error) => { return Err(error); } };
        let work = match recoverable_work_store_load(self.redaction, self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        let check = match load(self.redaction, self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        let followup = match followup_load(self.redaction, self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        let followup_check = match followup_checks_load(self.redaction, self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        let additional = match continuous_work_load(self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        return Ok({ chat, work, check, followup, followup_check, additional });
    }
}
