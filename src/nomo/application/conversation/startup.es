module nomo.application.conversation.startup;

import nomo.domain.conversation.session.Session;
import nomo.domain.conversation.start.SessionSelection;
import nomo.application.conversation.ports.{ConversationReader, ConversationCatalog, ConversationPicker};

flow existing<R ~ ConversationReader, C ~ ConversationCatalog>(reader: R, catalog: C, workspace: string, id: string, activate: bool) -> Session {
    let value = reader.load(id);
    // A foreign project is routed before its files, tools or selection are used.
    if activate && value.workspace == workspace { return catalog.select(workspace, id); }
    return value;
}

public flow select<R ~ ConversationReader, C ~ ConversationCatalog, P ~ ConversationPicker>(reader: R, catalog: C, picker: P, workspace: string, selection: SessionSelection, activate: bool, all_sessions: bool) -> Option<Session> {
    return match selection {
        SessionSelection.Fresh => Some(catalog.create(workspace, "New conversation")),
        SessionSelection.Exact(id) => Some(existing(reader, catalog, workspace, id, activate)),
        SessionSelection.Choose => match picker.choose(if all_sessions { catalog.all_sessions() } else { catalog.sessions(workspace) }) {
            Some(id) => Some(existing(reader, catalog, workspace, id, activate)),
            None() => None()
        },
        SessionSelection.Current => match catalog.selected(workspace) {
            Some(id) => Some(existing(reader, catalog, workspace, id, activate)),
            None() => Some(catalog.create(workspace, "New conversation"))
        },
        SessionSelection.Existing => match catalog.selected(workspace) {
            Some(id) => Some(existing(reader, catalog, workspace, id, activate)),
            None() => abort("no saved conversation is selected for this project"),
        }
    };
}
