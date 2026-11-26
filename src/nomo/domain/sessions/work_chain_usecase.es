module nomo.domain.sessions.work_chain_usecase;

import nomo.domain.mutations.edit_contract.Selector;
import nomo.session.work_chain.{Caps, Record};
import nomo.harness.harness_work_contract.Ledger;
import nomo.domain.sessions.work_chain_journal_contract.CapturedJournal;

public type WorkRequest = { selected: Selector, request: string, allowed: Array<string>, cap: Caps };

public type ContinueRequest = { parent: string, work: WorkRequest };

public enum TurnRequest { New(WorkRequest), Continue(ContinueRequest) }

public type WorkStop = { state: Ledger, error: string };

public enum WorkOutcome { Completed, Stopped(WorkStop) }

public type CapturedShow = { row: Record, journal: Option<CapturedJournal> };
