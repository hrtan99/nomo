module nomo.adapters.storage.recoverable_status;

import std.memory.MemoryEntry;
import nomo.application.sessions.status.SessionStatusReader;
import nomo.domain.sessions.redaction.Policy;
import nomo.session.recoverable_chat_store.Frame as ChatFrame;
import nomo.adapters.storage.legacy.recoverable_chat_store.load as load_chat;
import nomo.session.recoverable_work_store.Frame as WorkFrame;
import nomo.adapters.storage.legacy.recoverable_work_store.load as load_work;
import nomo.session.check_store.Frame as CheckFrame;
import nomo.adapters.storage.legacy.recoverable_check_store.load as load_check;
import nomo.session.recoverable_followup_store.Frame as FollowupFrame;
import nomo.adapters.storage.legacy.recoverable_followup_store.load as load_followup;
import nomo.adapters.storage.legacy.recoverable_followup_check_store.load as load_followup_check;
import nomo.domain.sessions.continuous_work.Stored;
import nomo.adapters.storage.legacy.continuous_work.load as load_continuous;

public alias ChatEntry = MemoryEntry<string, ChatFrame>;
public alias WorkEntry = MemoryEntry<string, WorkFrame>;
public alias CheckEntry = MemoryEntry<string, CheckFrame>;
public alias FollowupEntry = MemoryEntry<string, FollowupFrame>;
public alias Snapshot = { chat: ChatEntry, work: Option<WorkEntry>, check: Option<CheckEntry>,
    followup: Option<FollowupEntry>, followup_check: Option<CheckEntry>, additional: Option<Stored> };
public type RecoverableSessionStatusReader = { redaction: Policy, binding: string };

impl RecoverableSessionStatusReader ~ SessionStatusReader<Snapshot> {
    flow snapshot(self) -> Result<Snapshot, string> {
        let chat = match load_chat(self.redaction, self.binding) { Ok(Some(value)) => value, Ok(None()) => { return Err("recoverable session missing"); } Err(error) => { return Err(error); } };
        let work = match load_work(self.redaction, self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        let check = match load_check(self.redaction, self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        let followup = match load_followup(self.redaction, self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        let followup_check = match load_followup_check(self.redaction, self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        let additional = match load_continuous(self.binding) { Ok(value) => value, Err(error) => { return Err(error); } };
        return Ok({ chat, work, check, followup, followup_check, additional });
    }
}
