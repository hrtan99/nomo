module app.main;

import app.old_conversations.{Copies as T88, Data as T83};
import app.old_jobs.ArchivedJobs as T91;
import app.old_journals.Data as T94;
import nomo.domain.archives.CopyJob as T89;
import nomo.domain.attempts.Attempt as T95;
import nomo.domain.changes.{Journal as T4, Step as T6};
import nomo.domain.conversation.{SavedSession as T84, StoredEvent as T86};
import nomo.domain.editing.EditOperation as T30;
import nomo.domain.process.archived_jobs.ArchivedJob as T93;
import nomo.domain.processes.{ArchivedJob as T92, Job as T9, JobEvent as T11};
import nomo.domain.sessions.chain.{EditJournalRecord as T75, Record as T78, RecoveryDecision as T69};
import nomo.domain.sessions.chat.{ChatEvidence as T59, ChatHistoryFrame as T18, ChatSession as T15, RecoverableChatFrame as T56};
import nomo.domain.sessions.checkpoints.{CheckpointRecord as T37, SuccessorRecord as T40};
import nomo.domain.sessions.event_codec.History as T34;
import nomo.domain.sessions.state.{DemoClaim as T24, MetadataRecord as T72};
import nomo.domain.sessions.user_context_chain_v4.{JournalRecord as T98, Record as T101};
import nomo.domain.sessions.work.{
    CheckFrame as T53,
    CheckOutputRecord as T21,
    CheckRecord as T43,
    ContinuousBook as T27,
    FollowupRecord as T50,
    RecoverableFollowupFrame as T63,
    RecoverableWorkFrame as T66,
    StoredWorkRecord as T81,
    WorkRecord as T47
};
import nomo.domain.settings.CachedConfiguration as T1;
import nomo.native.configuration.{Cached as T2, Data as T0};
import nomo.native.history.{CopyJob as T90, Event as T87, Session as T85};
import nomo.native.lifecycle.Attempt as T96;
import nomo.native.mutations.{Data as T3, Journal as T5, Step as T7};
import nomo.native.processes.{Data as T8, Job as T10, JobEvent as T12};
import nomo.native.projects.Data as T13;
import nomo.session.chat_history.{Frame as T19, Frames as T17, Legacy as T14};
import nomo.session.chat_session_contract.Session as T16;
import nomo.session.check_output.{Outputs as T20, Record as T22};
import nomo.session.check_store.Frame as T54;
import nomo.session.continuous_work.{Book as T28, Books as T26};
import nomo.session.demo_claim.{Claim as T25, Demo as T23};
import nomo.session.edit_operation.Record as T31;
import nomo.session.edit_operation_store.{Followups as T32, Operations as T29};
import nomo.session.event_history.{EventStore as T33, History as T35};
import nomo.session.harness_checkpoint_store.{Checkpoints as T36, Record as T38};
import nomo.session.harness_successor_store.{Record as T41, Successors as T39};
import nomo.session.history_check_store.Record as T44;
import nomo.session.history_first_check_rows.Checks as T42;
import nomo.session.history_followup_check_guard.Checks as T45;
import nomo.session.history_followup_guard.{Record as T51, Runs as T49};
import nomo.session.history_work_guard.{Record as T48, Runs as T46};
import nomo.session.metadata_store.Metadata as T71;
import nomo.session.recoverable_chat_store.{Evidence as T60, EvidenceFrames as T58, Frame as T57, Frames as T55};
import nomo.session.recoverable_check_store.Checks as T52;
import nomo.session.recoverable_followup_check_store.Checks as T61;
import nomo.session.recoverable_followup_store.{Frame as T64, Runs as T62};
import nomo.session.recoverable_work_store.{Frame as T67, Runs as T65};
import nomo.session.recovery_decision.{Decision as T70, Decisions as T68};
import nomo.session.store_record.Record as T73;
import nomo.session.user_context_chain_v4.Record as T102;
import nomo.session.user_context_chain_v4_journal.{Journal as T97, Record as T99};
import nomo.session.user_context_chain_v4_store.Chain as T100;
import nomo.session.work_chain.Record as T79;
import nomo.session.work_chain_journal.{Journal as T74, Record as T76};
import nomo.session.work_chain_store.Chain as T77;
import nomo.session.work_record.Record as T82;
import nomo.session.work_record_store.Work as T80;
import std.agent.message.Message;
import std.bytes.to_array;
import std.io.println;
import std.json.{JsonValue, stringify};
import std.memory.MemoryCursor;

flow export_0() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T0.Parsed.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T1>> = Message.new(entry.value).cast<T1>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-configuration-v1/Parsed"
                )
            };
            let codec = std.memory.codec<T1>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-configuration-v1/Parsed",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_1() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T3.Journals.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T4>> = Message.new(entry.value).cast<T4>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-file-journals-v1/Journals"
                )
            };
            let codec = std.memory.codec<T4>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-file-journals-v1/Journals",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_2() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T3.Steps.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T6>> = Message.new(entry.value).cast<T6>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-file-journals-v1/Steps"
                )
            };
            let codec = std.memory.codec<T6>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-file-journals-v1/Steps",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_3() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T8.Jobs.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T9>> = Message.new(entry.value).cast<T9>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-native-processes-v1/Jobs")
            };
            let codec = std.memory.codec<T9>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-processes-v1/Jobs",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_4() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T8.Outputs.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T11>> = Message.new(entry.value).cast<T11>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-processes-v1/Outputs"
                )
            };
            let codec = std.memory.codec<T11>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-processes-v1/Outputs",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_5() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T13.Recent.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<Array<string>>> = Message.new(entry.value).cast<Array<string>>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-native-projects-v1/Recent")
            };
            let codec = std.memory.codec<Array<string>>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-projects-v1/Recent",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_6() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T14.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T15>> = Message.new(entry.value).cast<T15>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-chat-history-v1/Rows")
            };
            let codec = std.memory.codec<T15>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-chat-history-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_7() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T17.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T18>> = Message.new(entry.value).cast<T18>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-chat-history-v3/Rows")
            };
            let codec = std.memory.codec<T18>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-chat-history-v3/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_8() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T20.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T21>> = Message.new(entry.value).cast<T21>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-check-output-v1/Rows")
            };
            let codec = std.memory.codec<T21>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-check-output-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_9() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T23.Claims.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T24>> = Message.new(entry.value).cast<T24>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-session-demo-v1/Claims")
            };
            let codec = std.memory.codec<T24>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-session-demo-v1/Claims",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_10() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T26.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T27>> = Message.new(entry.value).cast<T27>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-continuous-work-v1/Rows")
            };
            let codec = std.memory.codec<T27>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-continuous-work-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_11() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T29.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T30>> = Message.new(entry.value).cast<T30>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-edit-operation-v1/Rows")
            };
            let codec = std.memory.codec<T30>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-edit-operation-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_12() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T32.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T30>> = Message.new(entry.value).cast<T30>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-edit-followup-v1/Rows")
            };
            let codec = std.memory.codec<T30>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-edit-followup-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_13() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T33.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T34>> = Message.new(entry.value).cast<T34>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-event-history-v1/Rows")
            };
            let codec = std.memory.codec<T34>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-event-history-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_14() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T36.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T37>> = Message.new(entry.value).cast<T37>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-harness-checkpoint-v1/Rows"
                )
            };
            let codec = std.memory.codec<T37>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-harness-checkpoint-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_15() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T39.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T40>> = Message.new(entry.value).cast<T40>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-harness-successor-v1/Rows")
            };
            let codec = std.memory.codec<T40>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-harness-successor-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_16() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T42.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T43>> = Message.new(entry.value).cast<T43>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-history-check-v1/Rows")
            };
            let codec = std.memory.codec<T43>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-history-check-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_17() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T45.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T43>> = Message.new(entry.value).cast<T43>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-followup-check-v1/Rows")
            };
            let codec = std.memory.codec<T43>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-followup-check-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_18() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T46.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T47>> = Message.new(entry.value).cast<T47>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-history-work-v1/Rows")
            };
            let codec = std.memory.codec<T47>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-history-work-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_19() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T49.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T50>> = Message.new(entry.value).cast<T50>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-history-followup-v1/Rows")
            };
            let codec = std.memory.codec<T50>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-history-followup-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_20() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T52.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T53>> = Message.new(entry.value).cast<T53>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-recoverable-check-v1/Rows")
            };
            let codec = std.memory.codec<T53>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-recoverable-check-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_21() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T55.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T56>> = Message.new(entry.value).cast<T56>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-recoverable-chat-v1/Rows")
            };
            let codec = std.memory.codec<T56>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-recoverable-chat-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_22() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T58.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T59>> = Message.new(entry.value).cast<T59>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-recoverable-chat-evidence-v1/Rows"
                )
            };
            let codec = std.memory.codec<T59>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-recoverable-chat-evidence-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_23() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T61.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T53>> = Message.new(entry.value).cast<T53>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-recoverable-followup-check-v1/Rows"
                )
            };
            let codec = std.memory.codec<T53>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-recoverable-followup-check-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_24() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T62.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T63>> = Message.new(entry.value).cast<T63>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-recoverable-followup-v1/Rows"
                )
            };
            let codec = std.memory.codec<T63>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-recoverable-followup-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_25() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T65.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T66>> = Message.new(entry.value).cast<T66>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-recoverable-work-v1/Rows")
            };
            let codec = std.memory.codec<T66>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-recoverable-work-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_26() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T68.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T69>> = Message.new(entry.value).cast<T69>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-recovery-decision-v1/Rows")
            };
            let codec = std.memory.codec<T69>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-recovery-decision-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_27() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T71.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T72>> = Message.new(entry.value).cast<T72>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-session-store-v1/Rows")
            };
            let codec = std.memory.codec<T72>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-session-store-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_28() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T74.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T75>> = Message.new(entry.value).cast<T75>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-work-chain-edit-v2/Rows")
            };
            let codec = std.memory.codec<T75>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-work-chain-edit-v2/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_29() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T77.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T78>> = Message.new(entry.value).cast<T78>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-work-chain-v2/Rows")
            };
            let codec = std.memory.codec<T78>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-work-chain-v2/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_30() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T80.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T81>> = Message.new(entry.value).cast<T81>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-work-record-v1/Rows")
            };
            let codec = std.memory.codec<T81>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-work-record-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_31() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T83.Counters.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<i64>> = Message.new(entry.value).cast<i64>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-conversations-v1/Counters"
                )
            };
            let codec = std.memory.codec<i64>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-conversations-v1/Counters",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_32() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T83.Selected.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<string>> = Message.new(entry.value).cast<string>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-conversations-v1/Selected"
                )
            };
            let codec = std.memory.codec<string>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-conversations-v1/Selected",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_33() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T83.Sessions.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T84>> = Message.new(entry.value).cast<T84>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-conversations-v1/Sessions"
                )
            };
            let codec = std.memory.codec<T84>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-conversations-v1/Sessions",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_34() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T83.Events.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T86>> = Message.new(entry.value).cast<T86>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-conversations-v1/Events"
                )
            };
            let codec = std.memory.codec<T86>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-conversations-v1/Events",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_35() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T83.Chunks.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<string>> = Message.new(entry.value).cast<string>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-conversations-v1/Chunks"
                )
            };
            let codec = std.memory.codec<string>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-conversations-v1/Chunks",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_36() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T88.Jobs.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T89>> = Message.new(entry.value).cast<T89>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-conversation-copies-v1/Jobs"
                )
            };
            let codec = std.memory.codec<T89>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-conversation-copies-v1/Jobs",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_37() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T91.Jobs.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T92>> = Message.new(entry.value).cast<T92>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-project-jobs-v1/Jobs"
                )
            };
            let codec = std.memory.codec<T92>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-project-jobs-v1/Jobs",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_38() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T91.Parts.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<bytes>> = Message.new(entry.value).cast<bytes>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-project-jobs-v1/Parts"
                )
            };
            let codec = std.memory.codec<bytes>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-project-jobs-v1/Parts",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_39() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T94.Counter.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<i64>> = Message.new(entry.value).cast<i64>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-attempts-v1/Counter"
                )
            };
            let codec = std.memory.codec<i64>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-attempts-v1/Counter",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_40() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T94.Attempts.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T95>> = Message.new(entry.value).cast<T95>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-native-attempts-v1/Attempts"
                )
            };
            let codec = std.memory.codec<T95>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-native-attempts-v1/Attempts",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_41() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T97.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T98>> = Message.new(entry.value).cast<T98>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort("relocation payload conversion refused: " + "nomo-user-context-edit-v4/Rows")
            };
            let codec = std.memory.codec<T98>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-user-context-edit-v4/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

flow export_42() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    @limits([Iterations(2147483647)]) while true {
        let page = T100.Rows.page(cursor, 100);
        for entry in page.entries {
            let converted: Option<Message<T101>> = Message.new(entry.value).cast<T101>();
            let value = match converted {
                Some(value) => value.body,
                None() => abort(
                    "relocation payload conversion refused: "
                        + "nomo-user-context-chain-v4/Rows"
                )
            };
            let codec = std.memory.codec<T101>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("relocation encoding failed")
            };
            let row = ExportRow {
                store = "nomo-user-context-chain-v4/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            let json: Option<Message<JsonValue>> = Message.new(row).cast<JsonValue>();
            let body = match json {
                Some(value) => value.body,
                None() => abort("relocation row encoding failed")
            };
            println(
                match stringify(body) {
                    Ok(value) => value,
                    Err(_) => abort("relocation row stringify failed")
                }
            );
        }
        match page.cursor {
            Some(value) => {
                cursor = Some(value);
            },
            None() => {
                break;
            }
        }
    }
}

type ExportRow = {
    store: string,
    key: string,
    value: Array<u8>
};

public flow main(args: Array<string>) -> i32 ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    export_0();
    export_1();
    export_2();
    export_3();
    export_4();
    export_5();
    export_6();
    export_7();
    export_8();
    export_9();
    export_10();
    export_11();
    export_12();
    export_13();
    export_14();
    export_15();
    export_16();
    export_17();
    export_18();
    export_19();
    export_20();
    export_21();
    export_22();
    export_23();
    export_24();
    export_25();
    export_26();
    export_27();
    export_28();
    export_29();
    export_30();
    export_31();
    export_32();
    export_33();
    export_34();
    export_35();
    export_36();
    export_37();
    export_38();
    export_39();
    export_40();
    export_41();
    export_42();
    return 0;
}
