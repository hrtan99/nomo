module nomo.application.execution.service;

import std.text.from_i64;
import nomo.domain.execution.attempt.Attempt;
import nomo.domain.execution.transitions.{Transition, next_phase};
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, ResultPublication};

public flow turn_available<R ~ AttemptRepository>(repository: R, session: string) -> unit ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
    for value in repository.list(session, true) {
        if value.kind == "coding" || value.kind == "summary" {
            abort("inference has no recorded completion: " + value.id + "; inspect /runs, then /resolve-run ID NOTE before starting a new turn");
        }
    }
}

public flow begin<R ~ AttemptRepository>(repository: R, session: string, kind: string, label: string, input_event: i64, through: i64) -> Attempt
    ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    if kind == "coding" || kind == "summary" { turn_available(repository, session); }
    return repository.prepare(session, kind, label, input_event, through);
}

public flow dispatching<R ~ AttemptRepository>(repository: R, id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let value = repository.load(id);
    repository.update(id, next_phase(value, Transition.Dispatch, false), -1, -1);
}

public flow returned<R ~ AttemptRepository, P ~ ResultPublication>(repository: R, publication: P, id: string, role: string, name: string, text: string, call: i64) -> i64
    ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let value = repository.load(id);
    let phase = next_phase(value, Transition.Return, false);
    let index = publication.prepare_result(value.session, role, name, call);
    repository.update(id, phase, index, -1);
    publication.publish_result(value.session, index, text);
    return index;
}

public flow complete_attempt<R ~ AttemptRepository, P ~ ResultPublication, C ~ ConversationReader>(repository: R, publication: P, history: C, id: string) -> unit
    ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let value = repository.load(id);
    if value.phase == "completed" { return; }
    let complete = if value.result_event >= 0 { publication.result_complete(value.session, value.result_event) } else { false };
    let phase = next_phase(value, Transition.Complete, complete);
    if value.kind == "summary" { publication.select_summary(value.session, value.result_event, value.through); }
    if value.kind == "command" {
        let binding = value.session + ":" + from_i64(value.input_event) + " command";
        if history.load(value.session).pending == binding { publication.finish_command(value.session, value.input_event); }
    }
    repository.update(id, phase, value.result_event, value.recovery_event);
}

public flow resolve<R ~ AttemptRepository, P ~ ResultPublication, C ~ ConversationReader, W ~ ConversationWriter>(repository: R, publication: P, history: C, writer: W, session: string, id: string, note: string) -> Attempt
    ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let value = repository.load(id);
    if value.session != session { abort("attempt belongs to another conversation"); }
    if value.phase == "completed" || value.phase == "closed_unknown" { return value; }
    if value.result_event >= 0 && publication.result_complete(session, value.result_event) {
        complete_attempt(repository, publication, history, id);
        return repository.load(id);
    }
    if note == "" { abort("record your inspection and recovery decision in NOTE; the outcome remains unknown"); }
    let statement = "User closed unresolved " + value.kind + " " + id + ". Outcome remains unknown; no execution, success, process termination or replay is inferred. Inspection/decision: " + note;
    let binding = session + ":" + from_i64(value.input_event) + " command";
    let recovery_event = if value.kind == "command" && history.load(session).pending == binding {
        publication.acknowledge(session, value.input_event, statement)
    }
    else { writer.append(session, "recovery", "attempt_outcome_unknown", statement, value.input_event) };
    return repository.update(id, next_phase(value, Transition.CloseUnknown, false), value.result_event, recovery_event);
}
