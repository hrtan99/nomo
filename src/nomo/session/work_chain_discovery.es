module nomo.session.work_chain_discovery;

import nomo.session.work_chain.Record;
import nomo.session.work_chain_observation.{ObservationPass, observe as snapshot};
import nomo.session.work_chain_selection.{Snapshot, ObservedRow, Selector, select, consistent};

// These contracts bound actual native adapters. Observations are copied values,
// never native receipts, versions or write authority.
public spec SnapshotCapture: callable ObservationPass => Result<Snapshot, string> ![Memory, Error<StorageError>, Error<IndexError>];
public spec InspectAuthority: callable (string, string, string) => Result<Option<Record>, string> ![Memory, Error<StorageError>, Error<IndexError>];
public spec ConfirmedParentAuthority: callable (string, string, string) => Result<ObservedRow, string> ![Memory, Error<StorageError>, Error<IndexError>];
public effect DiscoveryAuthority {
    action inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string>;
    action confirmed_parent(id: string, workspace: string, path: string) -> Result<ObservedRow, string>;
}

public flow discover(workspace: string, path: string, selector: Selector) -> Result<Snapshot, string> {
    let before = match snapshot(workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let selected = match select(before, workspace, path, selector) { Ok(value) => value, Err(error) => { return Err(error); } };
    for row in selected limit Iterations(2) {
        let actual = match perform DiscoveryAuthority.inspect(row.id, workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
        if actual != Some(row) { return Err("v2 discovery selected row differs from inspect authority"); }
    }
    let after = match snapshot(workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let change = consistent(before, after); if change != "" { return Err(change); }
    return Ok(before);
}
public flow latest_parent(workspace: string, path: string) -> Result<string, string> {
    let before = match snapshot(workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let selected = match select(before, workspace, path, Selector.Parent) { Ok(value) => value, Err(error) => { return Err(error); } };
    let actual = match perform DiscoveryAuthority.confirmed_parent(selected[0].id, workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let root = match before.root { Some(value) => value, None() => { return Err("v2 discovery parent missing"); } };
    if actual.key != root.key || actual.version != root.version || actual.value != root.value { return Err("v2 discovered parent changed before continuation"); }
    let after = match snapshot(workspace, path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let change = consistent(before, after); if change != "" { return Err(change); }
    return Ok(actual.value.id);
}
