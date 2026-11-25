#!/usr/bin/env python3
"""Compose the prepared DIP overlays without selecting them for production.

The result is a single proposal against the current source tree. Its application
preflight and structural audit are not compiler or runtime acceptance.
"""

from __future__ import annotations

import difflib
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from etas_0224_migration import migrate, tokens


ROOT = Path(__file__).resolve().parents[1]
CANDIDATES = ROOT / "examples/native-project/candidates"
OUTPUT = ROOT / "tmp/dip-composed-0224-20261126/package"
OVERLAYS = [
    "read-context-dip07-0224",
    "foreground-command-dip08-0224",
    "conversation-composition-dip06-0224",
    "mutations-dip09-0224",
    "processes-dip10-0224",
    "configuration-instructions-dip11-0224",
    "transfer-project-terminal-dip12-0224",
]
# Later architectural extractions replace these earlier implementations. Entry,
# active agent effects and the composition root are merged explicitly below.
OWNERS = {
    "src/nomo/native/configuration.es": "configuration-instructions-dip11-0224",
    "src/nomo/native/mutations.es": "mutations-dip09-0224",
    "src/nomo/native/context.es": "conversation-composition-dip06-0224",
    "src/nomo/native/entry.es": "conversation-composition-dip06-0224",
    "src/nomo/native/agent.es": "mutations-dip09-0224",
    "src/nomo/bootstrap/native.es": "mutations-dip09-0224",
    "src/nomo/main.es": "mutations-dip09-0224",
}


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def replace(files: dict[str, str], path: str, old: str, new: str) -> None:
    assert old in files[path], (path, old)
    files[path] = files[path].replace(old, new)


def compose() -> tuple[dict[str, str], dict[str, str], dict]:
    paths = subprocess.check_output(
        ["git", "ls-files", "src"], cwd=ROOT, text=True
    ).splitlines()
    before = {name: (ROOT / name).read_text() for name in paths if name.endswith(".es")}
    variants: dict[str, list[tuple[str, str]]] = {}
    inputs = {}
    for name in OVERLAYS:
        patch = CANDIDATES / (name + ".patch")
        text = patch.read_text()
        inputs[name] = digest(text)
        touched = [line[6:] for line in text.splitlines() if line.startswith("+++ b/")]
        with tempfile.TemporaryDirectory(prefix="nomo-dip-overlay-") as folder:
            stage = Path(folder)
            for path in touched:
                source = ROOT / path
                if source.exists():
                    before.setdefault(path, source.read_text())
                    dest = stage / path
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, dest)
            subprocess.run(["git", "apply", "--check", str(patch)], cwd=stage, check=True)
            subprocess.run(["git", "apply", str(patch)], cwd=stage, check=True)
            for path in touched:
                variants.setdefault(path, []).append((name, (stage / path).read_text()))
    after = dict(before)
    for path, values in variants.items():
        if len(values) == 1:
            after[path] = values[0][1]
        else:
            after[path] = dict(values)[OWNERS[path]]

    # The replacement leaf no longer contains the foreground command functions.
    replace(after, "src/nomo/adapters/workspace/mutation_files.es",
            "import nomo.native.workspace.{ProjectRoot, execute_step};",
            "import nomo.native.workspace.ProjectRoot;\nimport nomo.bootstrap.command.execute_step;")
    replace(after, "src/nomo/adapters/configuration/converter.es",
            "import nomo.native.workspace.execute_readonly_input;",
            "import nomo.bootstrap.command.execute_readonly_input;")
    # Keep the cache resource and schema at their established nominal owner,
    # just as the other persistent contract leaves do.
    cache_declarations = (
        'alias Schema = MemoryRegion<{ Parsed: Store<string, Cached> }>;\n'
        'let Data = std.memory.region<Schema>(stable_id = "nomo-native-configuration-v1", store = "native-configuration");'
    )
    assert cache_declarations in before["src/nomo/native/configuration.es"]
    replace(after, "src/nomo/native/configuration.es",
            "public type Cached = { digest: bytes, session: string, result_event: i64 };",
            "public type Cached = { digest: bytes, session: string, result_event: i64 };\n"
            + cache_declarations.replace("let Data", "public let Data"))
    replace(after, "src/nomo/adapters/etas/configuration_cache.es",
            "import nomo.native.configuration.Cached;", "import nomo.native.configuration.{Cached, Data};")
    replace(after, "src/nomo/adapters/etas/configuration_cache.es", cache_declarations + "\n\n", "")

    # Context acquisition reads persisted jobs directly through the repository
    # role, never through model tools or ProcessOperations (which execute work).
    after["src/nomo/adapters/etas/context_inputs.es"] = '''module nomo.adapters.etas.context_inputs;

import nomo.application.native.context.ports.SavedJobsReader;
import nomo.application.native.processes.ports.JobRepository;
import nomo.adapters.etas.processes.NativeJobs;
import nomo.domain.process.jobs.Job;

public type SavedJobContext = { jobs: NativeJobs };
impl SavedJobContext ~ SavedJobsReader {
    flow read(self, session: string) -> Array<Job> ![Memory, Error<StorageError>] {
        return self.jobs.list(session);
    }
}
'''
    conversation = "src/nomo/bootstrap/conversation.es"
    replace(after, conversation,
            "import nomo.adapters.etas.context_inputs.{NativeInstructions, NativeJobs};",
            "import nomo.adapters.etas.context_inputs.SavedJobContext;\n"
            "import nomo.adapters.etas.processes.NativeJobs;\n"
            "import nomo.bootstrap.instructions.{ProjectGuidance, reader as guidance};")
    replace(after, conversation, "import nomo.native.configuration.load as load_configuration;",
            "import nomo.bootstrap.configuration.load as load_configuration;")
    replace(after, conversation, "instructions: NativeInstructions,\n    jobs: NativeJobs,",
            "instructions: ProjectGuidance,\n    jobs: SavedJobContext,")
    replace(after, conversation, "instructions = NativeInstructions {},\n        jobs = NativeJobs {},",
            "instructions = guidance(),\n        jobs = SavedJobContext { jobs = NativeJobs {} },")
    start = after[conversation].index("public flow ready_for_turn(")
    end = after[conversation].index("public flow ask(", start)
    after[conversation] = after[conversation][:start] + after[conversation][end:]
    replace(after, conversation, "turn, compact as compact_conversation, ready, supported",
            "turn, compact as compact_conversation")

    # Both real model tools now call injected operation effects. Carry the same
    # row through the agent, port, adapter, conversation composition and entry.
    operation_imports = (
        "import nomo.application.native.mutations.ports.ChangeOperations;\n"
        "import nomo.application.native.processes.ports.ProcessOperations;\n"
    )
    for path in ["src/nomo/native/agent.es", "src/nomo/application/native/conversation/model.es",
                 "src/nomo/adapters/model/native.es", conversation]:
        text = after[path]
        for line in operation_imports.splitlines(True):
            if line not in text:
                text = text.replace("\n\n", "\n\n" + line, 1)
        if path == conversation:
            text = text.replace("![Agentic, Memory, Console,", "![Agentic, ChangeOperations, ProcessOperations, Memory, Console,")
        else:
            text = text.replace("![SessionContext, ChangeOperations, SettingsContext,",
                                "![SessionContext, ChangeOperations, ProcessOperations, SettingsContext,")
            text = text.replace("![SessionContext, SettingsContext,",
                                "![SessionContext, ChangeOperations, ProcessOperations, SettingsContext,")
        after[path] = text

    # The entry uses existing ports for queries and recovery. A small application
    # request effect selects the already extracted turn/compaction/settings use
    # cases at bootstrap; it does not expose a concrete model or repository.
    after["src/nomo/application/native/conversation/requests.es"] = '''module nomo.application.native.conversation.requests;

import nomo.domain.configuration.settings.Settings;

public effect ConversationRequests {
    action turn(session: string, request: string) -> bool;
    action compact(session: string, settings: Settings) -> unit;
    action settings(session: string) -> Settings;
}
'''
    ports = "src/nomo/application/native/conversation/ports.es"
    replace(after, ports, "public spec ConversationCatalog {", "public spec ConversationCatalog {\n"
            "    flow rename(self, id: string, title: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];")
    replace(after, "src/nomo/adapters/etas/conversations.es", "impl NativeHistory ~ ConversationCatalog {",
            "impl NativeHistory ~ ConversationCatalog {\n"
            "    flow rename(self, id: string, title: string) -> unit { rename(id, title); }")

    entry = "src/nomo/native/entry.es"
    replace(after, entry,
            "import nomo.adapters.etas.conversations.{NativeHistory, rename, read_message as message, fork, copy_status, copy_jobs, copy_job, resume_fork, discard_copy};",
            "import nomo.application.native.execution.ports.AttemptRepository;")
    replace(after, entry, "ConversationReader, ConversationWriter, ConversationCatalog, GenerationReservation",
            "ConversationReader, ConversationWriter, ConversationCatalog, ResultPublication")
    replace(after, entry,
            "import nomo.bootstrap.conversation.{ask as run_turn, compact, ready_for_turn, generation_supported, settings_for as load_settings};",
            "import nomo.application.native.conversation.requests.ConversationRequests;\n"
            "import nomo.application.native.conversation.model.ConversationOutput;\n"
            "import nomo.application.native.conversation.controller.{ready, supported};")
    replace(after, entry,
            "import nomo.native.transfer.{save_archive, load_archive, resume_import};",
            "import nomo.native.transfer.{save_archive, load_archive, resume_import, fork, copy_status, copy_jobs, copy_job, resume_fork, discard_copy};\n"
            "import nomo.application.native.transfer.effects.TransferOperations;\n"
            "import nomo.application.native.projects.effects.ProjectOperations;")
    replace(after, entry,
            "import nomo.bootstrap.execution.{attempts, begin, dispatching, returned, complete_attempt, resolve};",
            "import nomo.application.native.execution.service.resolve;")
    replace(after, entry, "import nomo.domain.configuration.settings.{Settings, effective_window, as_number, estimated_tokens};",
            "import nomo.domain.configuration.settings.Settings;")
    replace(after, entry, "import nomo.native.configuration.{SettingsContext, load as load_configuration, status as configuration_status};",
            "import nomo.application.native.configuration.context.SettingsContext;\n"
            "import nomo.native.configuration.status as configuration_status;")
    replace(after, entry, "flow ask(session: string, request: string) -> bool { return run_turn(session, request); }",
            '''flow ask(session: string, request: string) -> bool { return perform ConversationRequests.turn(session, request); }

flow load_settings(session: string) -> Settings { return perform ConversationRequests.settings(session); }

flow ready_for_turn<A ~ AttemptRepository>(attempts: A, session: string) -> bool {
    return ready(attempts, session) with { ConversationOutput.write(line) => { println(line); resume; } };
}

flow generation_supported(settings: Settings) -> bool {
    return supported(settings) with { ConversationOutput.write(line) => { println(line); resume; } };
}''')
    replace(after, entry, "flow show(value: Session)", "flow show<A ~ AttemptRepository>(attempts: A, value: Session)")
    replace(after, entry, "for attempt in attempts(value.id, true)", "for attempt in attempts.list(value.id, true)")
    replace(after, entry, "flow show_history(session: string, query: string, first: i64, count: i64)",
            "flow show_history<R ~ ConversationReader>(archive: R, session: string, query: string, first: i64, count: i64)")
    replace(after, entry, "    let archive = NativeHistory {};\n    let selected = archive.load(session);", "    let selected = archive.load(session);")
    replace(after, entry, "let item = message(session, index);", "let item = archive.message(session, index);")
    replace(after, entry, "public flow run(args: Array<string>)", "public flow run<R ~ ConversationReader, W ~ ConversationWriter, C ~ ConversationCatalog, A ~ AttemptRepository, P ~ ResultPublication>(archive: R, writer: W, catalog: C, attempts: A, publication: P, args: Array<string>)")
    replace(after, entry, "    let archive = NativeHistory {};\n", "")
    for method in ["create", "selected", "select", "sessions"]:
        replace(after, entry, "archive." + method + "(", "catalog." + method + "(")
    replace(after, entry, "show(selected)", "show(attempts, selected)")
    replace(after, entry, "show(item)", "show(attempts, item)")
    replace(after, entry, "show_history(selected.id, query, first, count)", "show_history(archive, selected.id, query, first, count)")
    replace(after, entry, "rename(selected.id, title)", "catalog.rename(selected.id, title)")
    replace(after, entry, "attempts(selected.id, false)", "attempts.list(selected.id, false)")
    replace(after, entry, "resolve(selected.id, id, note)", "resolve(attempts, publication, archive, writer, selected.id, id, note)")
    replace(after, entry, "ready_for_turn(selected.id)", "ready_for_turn(attempts, selected.id)")
    replace(after, entry, "compact(selected.id, settings)", "perform ConversationRequests.compact(selected.id, settings)")
    after[entry] = after[entry].replace("\n\n", "\n\n" + operation_imports, 1)
    replace(after, entry, "![Agentic, Memory, Console,", "![Agentic, ConversationRequests, ChangeOperations, ProcessOperations, TransferOperations, ProjectOperations, Memory, Console,")

    # One actual root owns all effect installations. No candidate overrides
    # another candidate's root or drops its effects during assembly.
    native = "src/nomo/bootstrap/native.es"
    replace(after, native, "import nomo.native.entry;", "import nomo.native.entry;\n"
            "import nomo.adapters.etas.conversations.NativeHistory;\n"
            "import nomo.adapters.etas.attempts.NativeAttempts;\n"
            "import nomo.application.native.conversation.requests.ConversationRequests;\n"
            "import nomo.bootstrap.conversation;\nimport nomo.bootstrap.processes;\n"
            "import nomo.bootstrap.transfer;\nimport nomo.bootstrap.projects;")
    replace(after, native, "    return handle { entry.run(args) } with {", '''    let history_store = NativeHistory {};
    let attempts = NativeAttempts {};
    return handle {
        handle {
            handle {
                handle {
                    handle { entry.run(history_store, history_store, history_store, attempts, history_store, args) } with {
                        ConversationRequests.turn(session, request) => { resume conversation.ask(session, request); }
                        ConversationRequests.compact(session, settings) => { conversation.compact(session, settings); resume; }
                        ConversationRequests.settings(session) => { resume conversation.settings_for(session); }
                    }
                } with processes.bindings()
            } with transfer.operations()
        } with projects.operations()
    } with {''')
    return before, after, {"inputs": inputs, "overlap_owners": OWNERS}


def audit(before: dict[str, str], after: dict[str, str]) -> dict:
    """Check the composition seams that cannot be verified by apply preflight."""
    identities = {
        "src/nomo/native/configuration.es": ["Cached", "Schema", "Data"],
        "src/nomo/native/mutations.es": ["Journal", "SavedPath", "Step", "Schema", "Data"],
        "src/nomo/native/processes.es": ["Job", "JobEvent", "Schema", "Data"],
        "src/nomo/native/projects.es": ["LaunchRoot", "Schema", "Data"],
        "src/nomo/native/workspace.es": ["ProjectRoot"],
        "src/nomo/adapters/etas/conversations.es": ["Schema", "Data"],
    }

    def declaration(text, name):
        items = tokens(text)
        start = next(i for i in range(len(items) - 1)
                     if items[i].group() in ("type", "alias", "let") and items[i + 1].group() == name)
        end = next(i for i in range(start, len(items)) if items[i].group() == ";")
        return [m.group() for m in items[start:end + 1]]

    for path, names in identities.items():
        for name in names:
            assert declaration(before[path], name) == declaration(after[path], name), (path, name)
    for path in ["src/nomo/native/history.es", "src/nomo/native/lifecycle.es"]:
        assert before[path] == after[path], path
    for path, name in [("src/nomo/native/workspace.es", "ProjectRoot"),
                       ("src/nomo/native/projects.es", "LaunchRoot")]:
        impl = "impl " + name + " ~ Region;"
        assert impl in before[path] and impl in after[path], path

    modules = {re.search(r"^module ([\w.]+);", text).group(1): (path, text)
               for path, text in after.items() if path.startswith("src/") and path.endswith(".es")}
    imports = re.compile(r"(?:public\s+)?import\s+(nomo\.[\w.]+)(?:\{([^;]+)\})?(?:\s+as\s+\w+)?;")
    graph = {name: set() for name in modules}
    for name, (path, text) in modules.items():
        for match in imports.finditer(text):
            target = match.group(1).rstrip(".")
            while target not in modules and "." in target:
                target = target.rsplit(".", 1)[0]
            assert target in modules, (path, match.group())
            graph[name].add(target)
            if path.startswith(("src/nomo/application/", "src/nomo/domain/")):
                assert not target.startswith(("nomo.adapters.", "nomo.bootstrap.", "nomo.entry.")), (path, target)

    # Resolve named exports only; this is an import audit, not type/effect checking.
    exports = {name: set(re.findall(r"public\s+(?:type|enum|spec|effect|alias|let|flow|tool|agent)\s+(\w+)", text))
               for name, (_, text) in modules.items()}
    for name, (_, text) in modules.items():
        for match in imports.finditer(text):
            if not match.group().startswith("public"):
                continue
            if match.group(2):
                exports[name].update(part.strip().split(" as ")[-1] for part in match.group(2).split(","))
            else:
                exports[name].add(match.group().rstrip(";").split(" as ")[-1].rsplit(".", 1)[-1])
    imported_members = 0
    for _, (path, text) in modules.items():
        for match in imports.finditer(text):
            selected = match.group(1).rstrip(".")
            if match.group(2):
                members = [part.strip().split(" as ")[0] for part in match.group(2).split(",")]
                target = selected
            elif selected not in modules:
                target, member = selected.rsplit(".", 1)
                members = [member]
            else:
                continue
            for member in members:
                assert member in exports[target], (path, target, member)
                imported_members += 1
    assert not re.search(r"import nomo\.(adapters|bootstrap)\.", after["src/nomo/native/entry.es"])
    assert "NativeHistory" not in after["src/nomo/native/entry.es"]
    return {"kind": "static_import_and_persistent_declaration_audit_only",
            "modules": len(modules), "named_imports": imported_members,
            "module_import_edges": sum(map(len, graph.values())),
            "application_and_domain_import_direction": "passed",
            "entry_constructs_concrete_storage": False,
            "persistent_declarations_preserved": identities,
            "history_and_attempt_contract_leaves_byte_identical": True,
            "root_region_nominal_owners_preserved": True}


def main() -> None:
    before, after, report = compose()
    report["structural_audit"] = audit(before, after)
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    # Keep all actually present sources, including unchanged user prototypes, in
    # the source snapshot. The emitted patch touches only the owned tracked graph.
    shutil.copytree(ROOT / "src", OUTPUT / "src", dirs_exist_ok=True)
    for name in ["etas.toml", "etas.lock"]:
        shutil.copy2(ROOT / name, OUTPUT / name)
    changed = sorted(name for name in after if before.get(name, "") != after[name])
    for path in changed:
        dest = OUTPUT / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(after[path])
    patch = "".join(
        "diff --git a/" + name + " b/" + name + "\n"
        + ("new file mode 100644\n" if name not in before else "")
        + "".join(difflib.unified_diff(
            before.get(name, "").splitlines(True), after[name].splitlines(True),
            fromfile="a/" + name if name in before else "/dev/null", tofile="b/" + name))
        for name in changed
    )
    dest = CANDIDATES / "dip-composition-20261126.patch"
    dest.write_text(patch)
    subprocess.run(["git", "apply", "--check", str(dest)], cwd=ROOT, check=True)
    report.update({
        "status": "prepared_not_compiler_or_runtime_accepted",
        "baseline": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "patch_sha256": digest(patch), "changed_files": len(changed),
        "snapshot_source_count": len(list((OUTPUT / "src").rglob("*.es"))),
        "files": {name: {"before_sha256": digest(before[name]) if name in before else None,
                         "candidate_sha256": digest(after[name])} for name in changed},
        "entry_dependencies": ["ConversationReader", "ConversationWriter", "ConversationCatalog", "AttemptRepository", "ResultPublication", "ConversationRequests"],
        "cross_overlay_repairs": [
            "One composition root installs conversation, change, process, transfer and project operations.",
            "CodingModel, its implementation and the per-turn row carry change/process operations.",
            "Context reads JobRepository and injected ProjectGuidance; it does not execute process tools.",
            "Configuration converter and mutation filesystem adapter use the extracted command composition.",
            "Entry receives existing storage/recovery ports; bootstrap alone constructs their concrete backends.",
        ],
        "acceptance": "Apply preflight only. Language migration, normal target compilation and actual production scenarios remain required.",
        "production_selection_changed": False,
    })
    dest.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
    migrated, migration = migrate(after)
    migrated_dest = CANDIDATES / "dip-composition-0224-20261126.patch"
    migrated_changed = sorted(name for name in migrated if before.get(name, "") != migrated[name])
    migrated_patch = "".join(
        "diff --git a/" + name + " b/" + name + "\n"
        + ("new file mode 100644\n" if name not in before else "")
        + "".join(difflib.unified_diff(
            before.get(name, "").splitlines(True), migrated[name].splitlines(True),
            fromfile="a/" + name if name in before else "/dev/null", tofile="b/" + name))
        for name in migrated_changed
    )
    migrated_dest.write_text(migrated_patch)
    subprocess.run(["git", "apply", "--check", str(migrated_dest)], cwd=ROOT, check=True)
    target = OUTPUT.parent / "target-package"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(OUTPUT, target, dirs_exist_ok=True)
    for name in migrated_changed:
        (target / name).write_text(migrated[name])
    migration.update({
        "status": "prepared_not_target_compiler_accepted",
        "input_overlays": report["inputs"],
        "overlap_owners": report["overlap_owners"],
        "structural_audit_before_syntax_migration": report["structural_audit"],
        "composition_patch_sha256": report["patch_sha256"],
        "patch_sha256": digest(migrated_patch),
        "changed_files": len(migrated_changed),
        "source_baseline": report["baseline"],
        "files": {name: {"before_sha256": digest(before[name]) if name in before else None,
                         "candidate_sha256": digest(migrated[name])} for name in migrated_changed},
        "normal_target_check": "Not repeated: the exact documented scoped-loop form is blocked by upstream frontend#97.",
        "upstream": [
            "https://github.com/etas-project/etas-frontend/issues/97",
            "https://github.com/etas-project/etas-frontend/issues/99",
            "https://github.com/etas-project/etas-frontend/issues/100",
            "https://github.com/etas-project/etas-interpreter/issues/118",
        ],
        "production_selection_changed": False,
    })
    migrated_dest.with_suffix(".json").write_text(json.dumps(migration, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ["status", "changed_files", "snapshot_source_count", "patch_sha256"]}))
    print(json.dumps({key: migration[key] for key in ["agent_declarations", "instance_references", "bounded_loops", "changed_files", "patch_sha256"]}))


if __name__ == "__main__":
    main()
