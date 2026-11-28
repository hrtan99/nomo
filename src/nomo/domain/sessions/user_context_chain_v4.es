module nomo.domain.sessions.user_context_chain_v4;

import nomo.domain.sessions.chain.ChainEditPhase;
import nomo.domain.editing.Binding;
import nomo.domain.sessions.chain.{
    Caps,
    WorkChain as chain_Record,
    confirm as chain_confirm,
    initial as chain_initial,
    linked as chain_linked,
    publish_partial as chain_publish_partial,
    successor as chain_successor,
    work_chain_validate
};
import nomo.domain.sessions.work.CapturedWork;
import nomo.domain.text.{hex_digest, text_printable};
import nomo.domain.wire.{digest, fields as json_fields, value as json_value};
import std.json.{JsonValue, stringify};
import std.text.{len, trim};

public flow identity_error(identity: RootIdentity) -> string {
    if identity.version != 1 || len(identity.authority) == 0 || len(identity.authority) > 64
        || trim(identity.authority) == "" || !text_printable(identity.authority) || len(identity.token) == 0
        || len(identity.token) > 512 || trim(identity.token) == "" || !text_printable(identity.token) {
        return "invalid observed read-root identity";
    }
    return "";
}

flow serialized(row: RootBoundWorkChain) -> Result<string, string> {
    let data = json_fields(json_value(row), [("base", nomo.domain.sessions.chain.wire_chain(row.base))]);
    let encoded = match stringify(data) {
        Ok(value) => value,
        Err(_) => {
            return Err("v4 chain serialization refused");
        }
    };
    if len(encoded) > 263168 {
        return Err("v4 chain row exceeds serialized byte bound");
    }
    return Ok(encoded);
}

public flow validate(row: RootBoundWorkChain) -> string {
    if row.format != 4 || row.base.format != 2 {
        return "unsupported user-context chain format";
    }
    let identity = identity_error(row.root);
    if identity != "" {
        return identity;
    }
    let invalid = work_chain_validate(row.base);
    if invalid != "" {
        return invalid;
    }
    if row.base.turn == 1 && row.parent_proof != "" {
        return "v4 root has a parent proof";
    }
    if row.base.turn == 2 && !hex_digest(row.parent_proof) {
        return "invalid v4 parent proof";
    }
    return match serialized(row) {
        Ok(_) => "",
        Err(error) => error
    };
}

public flow fingerprint(row: RootBoundWorkChain) -> Result<string, string> {
    let invalid = validate(row);
    if invalid != "" {
        return Err(invalid);
    }
    let encoded = match serialized(row) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return digest(encoded);
}

public flow initial(
    id: string,
    workspace: string,
    path: string,
    request: string,
    allowed: Array<string>,
    policy: Caps,
    observed: RootIdentity
) -> Result<RootBoundWorkChain, string> {
    let invalid = identity_error(observed);
    if invalid != "" {
        return Err(invalid);
    }
    let base = match chain_initial(id, workspace, path, request, allowed, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let row = RootBoundWorkChain {
        format = 4,
        root = observed,
        parent_proof = "",
        base
    };
    let error = validate(row);
    if error != "" {
        return Err(error);
    }
    return Ok(row);
}

public flow successor(
    parent: RootBoundWorkChain,
    parent_version: string,
    id: string,
    request: string,
    allowed: Array<string>,
    policy: Caps,
    observed: RootIdentity
) -> Result<RootBoundWorkChain, string> {
    let invalid = validate(parent);
    if invalid != "" {
        return Err(invalid);
    }
    let identity = identity_error(observed);
    if identity != "" {
        return Err(identity);
    }
    if parent.root != observed {
        return Err("v4 read-root identity changed");
    }
    let base = match chain_successor(parent.base, parent_version, id, request, allowed, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let proof = match fingerprint(parent) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let child = RootBoundWorkChain {
        format = 4,
        root = parent.root,
        parent_proof = proof,
        base
    };
    let error = validate(child);
    if error != "" {
        return Err(error);
    }
    return Ok(child);
}

public flow linked(parent: RootBoundWorkChain, parent_version: string, child: RootBoundWorkChain) -> string {
    let invalid = validate(parent);
    if invalid != "" {
        return invalid;
    }
    let child_error = validate(child);
    if child_error != "" {
        return child_error;
    }
    if parent.root != child.root {
        return "v4 read-root identity changed";
    }
    let lineage = chain_linked(parent.base, parent_version, child.base);
    if lineage != "" {
        return lineage;
    }
    let proof = match fingerprint(parent) {
        Ok(value) => value,
        Err(error) => {
            return error;
        }
    };
    return if child.parent_proof == proof {
        ""
    } else {
        "v4 parent proof changed"
    };
}

public flow publish_partial(row: RootBoundWorkChain, work: CapturedWork) -> Result<RootBoundWorkChain, string> {
    let invalid = validate(row);
    if invalid != "" {
        return Err(invalid);
    }
    let base = match chain_publish_partial(row.base, work) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let next = row {
        base
    };
    let error = validate(next);
    if error != "" {
        return Err(error);
    }
    return Ok(next);
}

public flow confirm(row: RootBoundWorkChain, summary: string) -> Result<RootBoundWorkChain, string> {
    let invalid = validate(row);
    if invalid != "" {
        return Err(invalid);
    }
    let base = match chain_confirm(row.base, summary) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let next = row {
        base
    };
    let error = validate(next);
    if error != "" {
        return Err(error);
    }
    return Ok(next);
}

public type RootIdentity = {
    version: i32,
    authority: string,
    token: string
};

public type RootBoundWorkChain = {
    format: i32,
    root: RootIdentity,
    parent_proof: string,
    base: chain_Record
};

// Separate namespace: never reinterpret an existing v2 or v3 journal.
public type RootBoundChainJournal = {
    format: i32,
    chain: string,
    turn: i32,
    phase: ChainEditPhase,
    root: RootIdentity,
    binding: Binding
};
