module app.main;

import std.io.println;
import std.io.IOError;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.conversations.copy_status;
import nomo.adapters.storage.conversations.copy_jobs;
import nomo.adapters.storage.conversations.prepare_copy;
import nomo.adapters.storage.conversations.ensure_copy_session;
import nomo.adapters.storage.conversations.advance_copy;
import nomo.adapters.storage.conversations.copy_event;
import nomo.adapters.storage.conversations.sealed_copy_source;
import nomo.adapters.storage.conversations.copy_summary;
import nomo.adapters.storage.conversations.copy_record_complete;
import nomo.adapters.storage.conversations.copy_job;
import nomo.application.conversation.ports.ConversationReader;
import nomo.application.conversation.ports.ConversationWriter;
import nomo.application.conversation.ports.ConversationCatalog;
import nomo.domain.conversation.ChatMessage;
import nomo.domain.archives.ArchiveDocument;
import nomo.domain.archives.PortableArchive;
import nomo.domain.archives.PortableInfo;
import nomo.adapters.codec.json;
import nomo.adapters.codec.archive_decode as decode;
import nomo.adapters.codec.archive_fingerprint as fingerprint;
import nomo.application.transfer.service;
import nomo.application.transfer.ports.CopyStorage;
import nomo.application.transfer.ports.ArchiveCodec;
import nomo.application.transfer.ports.ArchiveFiles;
import nomo.application.transfer.ports.TransferDisplay;

public flow main(args: Array<string>) -> i32 ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>, Error<BudgetExceeded>] {
    let history = NativeHistory {};
    let source = history.create("transfer-controller", "Original conversation");
    history.append(source.id, "user", "", "original objective", -1);
    history.append(source.id, "assistant", "", "retained answer", -1);
    history.append(source.id, "summary", "context_summary", "summary snapshot", -1);
    let events = [ChatMessage { id = "external-0", role = "user", name = "", text = "imported first" },
        ChatMessage { id = "external-1", role = "assistant", name = "", text = "imported second" }];
    let raw = json(PortableArchive { format = "nomo-native-conversation-1", session = PortableInfo { id = "external", workspace = "historical", title = "Imported conversation", metadata = "" }, events = events });
    let partial = prepare_copy("transfer-controller", "Imported conversation", "import", "mutable-source.json", fingerprint(raw), 2);
    ensure_copy_session(partial.id);
    copy_event(partial.id, 0, "archive", "imported_source", raw);
    advance_copy(partial.id, 0, "copying");
    copy_event(partial.id, 1, events[0].role, events[0].name, events[0].text);
    advance_copy(partial.id, 1, "copying");
    handle {
        let forked = service.fork(history, history, source.id, 2);
        let fork_job = copy_job(forked.id);
        if fork_job.phase != "ready" || fork_job.cursor != 3 || forked.summary_event != 4 || forked.summary_through != -1 { abort("fork completion changed"); }
        if history.message(forked.id, 1).text != "original objective" || history.message(forked.id, 4).text != "summary snapshot" { abort("fork data changed"); }
        println("PASS application fork preserves events and summary");
        let resumed = service.resume_import(history, history, "transfer-controller", partial.id);
        if copy_job(resumed.id).phase != "ready" || copy_job(resumed.id).cursor != 2 || resumed.pending != "" { abort("import resume phase changed"); }
        if history.message(resumed.id, 0).text != raw || history.message(resumed.id, 1).text != "imported first" || history.message(resumed.id, 2).text != "imported second" { abort("sealed import source or prefix changed"); }
        if history.selected("transfer-controller") != Some(resumed.id) { abort("finished copy was not selected"); }
        println("PASS application resume uses sealed source and durable cursor");
    } with {
        CopyStorage.lookup(id) => copy_status(id);
        CopyStorage.list(workspace) => copy_jobs(workspace);
        CopyStorage.prepare(workspace, title, kind, original, digest, total) => prepare_copy(workspace, title, kind, original, digest, total);
        CopyStorage.ensure_session(id) => ensure_copy_session(id);
        CopyStorage.advance(id, cursor, phase) => advance_copy(id, cursor, phase);
        CopyStorage.event(id, index, role, name, text) => {
            if id == partial.id && index == 1 { abort("resume rewrote its completed prefix"); }
            copy_event(id, index, role, name, text)
        };
        CopyStorage.sealed(id) => sealed_copy_source(id);
        CopyStorage.summary(id, slot) => copy_summary(id, slot);
        CopyStorage.complete(id, index) => copy_record_complete(id, index);
        ArchiveCodec.encode(value) => match value { ArchiveDocument.Metadata(value) => json(value), ArchiveDocument.Conversation(value) => json(value), ArchiveDocument.Outcome(value) => json(value) };
        ArchiveCodec.decode(raw) => decode(raw);
        ArchiveCodec.fingerprint(raw) => fingerprint(raw);
        ArchiveFiles.read(path) => abort("sealed import reread its mutable source");
        ArchiveFiles.target(path) => abort("unexpected export target");
        ArchiveFiles.replace(target, text) => abort("unexpected export write");
        TransferDisplay.progress(id, copied, total) => {
            let current = copy_job(id);
            if current.phase != "copying" || current.cursor != copied || current.total != total || !copy_record_complete(id, copied) { abort("progress preceded durable copy state"); }
            if history.selected("transfer-controller") == Some(id) { abort("copy selected before completion"); }
            println("PORT copy progress after durable cursor"); ()
        }
        TransferDisplay.preview(value) => abort("unexpected export preview");
        TransferDisplay.exported(path) => abort("unexpected export completion");
    };
    return 0;
}
