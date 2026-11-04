module nomo.application.history_contract;

public type CheckOutput = { stdout: string, stderr: string, stdout_truncated: bool, stderr_truncated: bool };
public type WorkFacts = { id: string, summary: string, summary_source: string, selection: Option<string>, check: string, exit_code: string, output: Option<CheckOutput> };
public type BudgetFacts = { work_calls: i32, work_generation: i32, chat_used_calls: i32, chat_used_generation: i32, chat_reserved_calls: i32, chat_reserved_generation: i32 };
public type Facts = { first: Option<WorkFacts>, followup: Option<WorkFacts>, additional: Array<WorkFacts>, calls: i32, generation: i32 };
public spec WorkFactsReader {
    flow snapshot(self) -> Result<Facts, string> ![Memory, Error<StorageError>, Error<IndexError>];
}
