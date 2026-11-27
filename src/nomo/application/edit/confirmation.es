module nomo.application.edit.confirmation;

import std.io.IOError as ConsoleError;
import std.text.from_usize;
import nomo.application.edit.effects.Approval;
import nomo.application.edit.ports.{Preview, PreviewPresenter, CurrentEditConsent};
import nomo.domain.mutations.edit_contract.{Selector, Prepared};
import nomo.domain.mutations.edit_proposal.validate;
import nomo.domain.mutations.edit_binding.bind;
import nomo.domain.mutations.edit_diff.render_edit;
import nomo.session.edit_operation.Binding;
import nomo.domain.sessions.edit_operation.selector_error;
import nomo.domain.serialization.json.encode as encode_json;
import nomo.domain.context.large_context.edit_json_bytes;
import nomo.domain.sessions.session_display.ascii_json_with;

type PreviewMachine = { format: string, id: string, workspace: string, region: string, path: string,
    before: string, target: string, replacement: string, after: string, before_bytes: string, after_bytes: string,
    before_digest: string, after_digest: string, request_digest: string };

flow preview(value: Prepared, selected: Binding) -> Result<string, string> {
    // The runtime codec owns the complete JSON representation. A final bounded
    // pass keeps Unicode, including invisible and bidirectional scalars, from
    // being emitted raw to the terminal.
    let machine = PreviewMachine { format = "nomo-edit-preview-v1", id = selected.id, workspace = selected.workspace,
        region = selected.region, path = selected.path, before = value.proposal.before, target = value.request.target,
        replacement = value.request.replacement, after = value.proposal.after, before_bytes = from_usize(selected.before_bytes),
        after_bytes = from_usize(selected.after_bytes), before_digest = selected.before_digest,
        after_digest = selected.after_digest, request_digest = selected.request_digest };
    let json = match encode_json(machine, "edit preview JSON conversion refused", "edit preview JSON encoding refused") {
        Ok(text) => text, Err(error) => { return Err(error); }
    };
    return ascii_json_with(json, edit_json_bytes(), edit_json_bytes(),
        "edit preview JSON input exceeds bound", "edit preview JSON output exceeds bound");
}

public flow build_preview(selector: Selector, prepared: Prepared) -> Result<Preview, string> {
    let invalid = selector_error(selector.id, selector.workspace, selector.path); if invalid != "" { return Err(invalid); }
    if selector.path != prepared.request.path || selector.path != prepared.proposal.path { return Err("edit selector differs from prepared request"); }
    match validate(prepared.request, prepared.proposal) { Ok(_) => (), Err(error) => { return Err(error); } }
    let selected = match bind(selector.id, selector.workspace, selector.path, prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    let shown = match preview(prepared, selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    let readable = match render_edit(prepared.proposal.before, prepared.request.target, prepared.request.replacement, prepared.proposal.after) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Preview { binding = selected, machine = shown, diff = readable });
}
public flow confirm_using<P ~ PreviewPresenter, C ~ CurrentEditConsent>(presenter: P, consent: C, selector: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, Approval, Error<ConsoleError>, Error<IndexError>, Error<BudgetExceeded>] {
    let shown = match build_preview(selector, prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    presenter.present(shown);
    return consent.confirm(shown);
}
