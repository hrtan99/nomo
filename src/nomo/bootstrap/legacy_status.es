module nomo.bootstrap.legacy_status;

import nomo.application.status_contract.SessionStatusReader;
import nomo.session.chat_history.{Entry, load as load_chat};
import nomo.session.history_work_guard.{Record as WorkRecord, inspect as inspect_work};
import nomo.session.edit_operation.{Record as EditRecord};
import nomo.session.edit_operation_store.inspect as inspect_edit;
import nomo.session.history_check_guard.{Record as CheckRecord, inspect as inspect_check};
import nomo.session.history_followup_guard.{Record as FollowupRecord, inspect as inspect_followup};
import nomo.session.history_followup_edit_store.inspect as inspect_followup_edit;
import nomo.session.history_followup_check_guard.{Record as FollowupCheckRecord, inspect as inspect_followup_check};
import nomo.session.recovery_decision.{Decision, get as get_decision};

public type LegacyStatus = { chat: Entry, work: Option<WorkRecord>, work_edit: Option<EditRecord>, check: Option<CheckRecord>,
    followup: Option<FollowupRecord>, followup_edit: Option<EditRecord>, followup_check: Option<FollowupCheckRecord>, decisions: Array<Decision> };
public type LegacySessionStatusReader = {};

impl LegacySessionStatusReader ~ SessionStatusReader<LegacyStatus> {
    flow snapshot(self) -> Result<LegacyStatus, string> {
        let chat = match load_chat() { Ok(Some(value)) => value, Ok(None()) => { return Err("SESSION missing"); } Err(error) => { return Err(error); } };
        let work = match inspect_work() { Ok(value) => value, Err(error) => { return Err(error); } };
        var work_edit: Option<EditRecord> = None();
        match work { Some(value) => { work_edit = match inspect_edit(value.id, value.workspace, value.path) { Ok(item) => item, Err(error) => { return Err(error); } }; } None() => {} }
        let check = match inspect_check() { Ok(value) => value, Err(error) => { return Err(error); } };
        let followup = match inspect_followup() { Ok(value) => value, Err(error) => { return Err(error); } };
        var followup_edit: Option<EditRecord> = None();
        match followup { Some(value) => { followup_edit = match inspect_followup_edit(value.id, value.workspace, value.path) { Ok(item) => item, Err(error) => { return Err(error); } }; } None() => {} }
        let followup_check = match inspect_followup_check() { Ok(value) => value, Err(error) => { return Err(error); } };
        var decisions: Array<Decision> = [];
        for target in ["work", "check", "followup", "followup-check"] limit Iterations(4) {
            let decision = match get_decision(target) { Ok(value) => value, Err(error) => { return Err(error); } };
            match decision { Some(value) => { decisions = decisions.push(value); } None() => {} }
        }
        return Ok(LegacyStatus { chat = chat, work = work, work_edit = work_edit, check = check,
            followup = followup, followup_edit = followup_edit, followup_check = followup_check, decisions = decisions });
    }
}

public flow legacy_status_reader() -> LegacySessionStatusReader { return LegacySessionStatusReader {}; }
