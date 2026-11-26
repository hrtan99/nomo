module nomo.application.chat.controller;

import nomo.domain.harness.harness_tool_chat_contract.TurnResult;
import nomo.application.chat.ports.ChatRepository;

public alias Reservation<Ticket> = { prior: Ticket, reserved: Ticket };

public flow open<Ticket, R ~ ChatRepository<Ticket>>(repository: R, create: bool) -> Result<Ticket, string> {
    let existing = match repository.load() { Ok(value) => value, Err(error) => { return Err(error); } };
    let selected: Ticket = if create {
        match existing { Some(_) => { return Err(repository.exists_error()); } None() => {} }
        match repository.create() { Ok(value) => value, Err(error) => { return Err(error); } }
    } else {
        match existing { Some(value) => value, None() => { return Err(repository.missing_error()); } }
    };
    return Ok(selected);
}

public flow reserve_loaded<Ticket, R ~ ChatRepository<Ticket>>(repository: R, current: Ticket, request: string) -> Result<Reservation<Ticket>, string> {
    let ticket = match repository.reserve(current, request) { Ok(value) => value, Err(error) => { return Err(error); } };
    let verified = match repository.verified(ticket) { Ok(value) => value, Err(error) => { return Err(error); } };
    if !verified { return Err("reservation changed"); }
    let reservation: Reservation<Ticket> = { prior = current, reserved = ticket };
    return Ok(reservation);
}

public flow finish<Ticket, R ~ ChatRepository<Ticket>>(repository: R, ticket: Ticket, result: TurnResult) -> Result<bool, string> {
    if result.status != 0 || !result.resolved { return Err(repository.unresolved_error()); }
    return repository.finish(ticket, result);
}
