module app.main;

import app.baseline_sources;
import app.baseline_upgrade.{
    upgrade_0,
    upgrade_1,
    upgrade_2,
    upgrade_3,
    upgrade_4,
    upgrade_7,
    upgrade_9,
    upgrade_10,
    upgrade_11,
    upgrade_16,
    upgrade_17,
    upgrade_18,
    upgrade_19,
    upgrade_20,
    upgrade_21,
    upgrade_22,
    upgrade_24,
    upgrade_25,
    upgrade_27,
    upgrade_28,
    upgrade_29,
    upgrade_30,
    upgrade_35,
    upgrade_36,
    upgrade_37,
    upgrade_38,
    upgrade_39,
    upgrade_40,
    upgrade_41,
    upgrade_42
};
import std.memory.MemoryCursor;
import std.bytes.to_array;
import std.io.println;
import nomo.domain.wire.encode;

type ExportRow = {
    store: string,
    key: string,
    value: Array<u8>
};

flow export_0() -> unit ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    var cursor: Option<MemoryCursor> = None();
    while true {
        let page = app.baseline_sources.Source0.Parsed.page(cursor, 100);
        for entry in page.entries {
            let value = entry.value;
            let codec = std.memory.codec<nomo.domain.settings.CachedConfiguration>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-configuration-v1/Parsed",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source1.Journals.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_0(entry.value);
            let codec = std.memory.codec<nomo.domain.changes.FileJournal>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-file-journals-v1/Journals",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source1.Steps.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_1(entry.value);
            let codec = std.memory.codec<nomo.domain.changes.FileStep>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-file-journals-v1/Steps",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source2.Jobs.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_2(entry.value);
            let codec = std.memory.codec<nomo.domain.processes.ProcessJob>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-processes-v1/Jobs",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source2.Outputs.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_3(entry.value);
            let codec = std.memory.codec<nomo.domain.processes.ProcessOutput>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-processes-v1/Outputs",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source3.Recent.page(cursor, 100);
        for entry in page.entries {
            let value = entry.value;
            let codec = std.memory.codec<Array<string>>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-projects-v1/Recent",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source4.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_4(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.chat.ChatSessionState>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-chat-history-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source5.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_7(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.chat.ChatHistorySnapshot>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-chat-history-v3/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source6.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_9(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.CapturedCheckOutput>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-check-output-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source7.Claims.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_10(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.state.DemoSessionClaim>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-session-demo-v1/Claims",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source8.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_11(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.ContinuousWorkHistory>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-continuous-work-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source9.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_16(entry.value);
            let codec = std.memory.codec<nomo.domain.editing.LiteralEditRecord>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-edit-operation-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source10.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_16(entry.value);
            let codec = std.memory.codec<nomo.domain.editing.LiteralEditRecord>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-edit-followup-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source11.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_17(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.event_codec.RecordedTraceHistory>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-event-history-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source12.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_18(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.checkpoints.StoredCheckpoint>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-harness-checkpoint-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source13.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_19(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.checkpoints.StoredSuccessor>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-harness-successor-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source14.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_20(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.CheckAttempt>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-history-check-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source15.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_20(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.CheckAttempt>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-followup-check-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source16.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_21(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.WorkAttempt>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-history-work-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source17.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_22(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.FollowupAttempt>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-history-followup-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source18.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_24(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.CapturedCheckAttempt>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-recoverable-check-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source19.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_25(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.chat.ChatSessionSnapshot>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-recoverable-chat-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source20.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = entry.value;
            let codec = std.memory.codec<nomo.domain.sessions.chat.ChatEvidence>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-recoverable-chat-evidence-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source21.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_24(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.CapturedCheckAttempt>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-recoverable-followup-check-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source22.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_27(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.FollowupSessionFrame>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-recoverable-followup-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source23.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_28(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.WorkSessionFrame>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-recoverable-work-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source24.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_29(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.chain.RecordedRecovery>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-recovery-decision-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source25.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_30(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.state.StoredSessionMetadata>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-session-store-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source26.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_35(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.chain.ChainEditJournal>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-work-chain-edit-v2/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source27.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_36(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.chain.WorkChain>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-work-chain-v2/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source28.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_37(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.work.CapturedWork>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-work-record-v1/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source29.Counters.page(cursor, 100);
        for entry in page.entries {
            let value = entry.value;
            let codec = std.memory.codec<i64>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-conversations-v1/Counters",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source29.Selected.page(cursor, 100);
        for entry in page.entries {
            let value = entry.value;
            let codec = std.memory.codec<string>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-conversations-v1/Selected",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source29.Sessions.page(cursor, 100);
        for entry in page.entries {
            let value = entry.value;
            let codec = std.memory.codec<nomo.domain.conversation.SavedSession>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-conversations-v1/Sessions",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source29.Events.page(cursor, 100);
        for entry in page.entries {
            let value = entry.value;
            let codec = std.memory.codec<nomo.domain.conversation.StoredEvent>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-conversations-v1/Events",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source29.Chunks.page(cursor, 100);
        for entry in page.entries {
            let value = entry.value;
            let codec = std.memory.codec<string>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-conversations-v1/Chunks",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source30.Jobs.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_38(entry.value);
            let codec = std.memory.codec<nomo.domain.archives.ConversationCopy>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-conversation-copies-v1/Jobs",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source31.Jobs.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_39(entry.value);
            let codec = std.memory.codec<nomo.domain.processes.ArchivedProcessJob>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-project-jobs-v1/Jobs",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source31.Parts.page(cursor, 100);
        for entry in page.entries {
            let value = entry.value;
            let codec = std.memory.codec<bytes>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-project-jobs-v1/Parts",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source32.Counter.page(cursor, 100);
        for entry in page.entries {
            let value = entry.value;
            let codec = std.memory.codec<i64>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-attempts-v1/Counter",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source32.Attempts.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_40(entry.value);
            let codec = std.memory.codec<nomo.domain.attempts.ExecutionAttempt>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-native-attempts-v1/Attempts",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source33.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_41(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.user_context_chain_v4.RootBoundChainJournal>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-user-context-edit-v4/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
    while true {
        let page = app.baseline_sources.Source34.Rows.page(cursor, 100);
        for entry in page.entries {
            let value = upgrade_42(entry.value);
            let codec = std.memory.codec<nomo.domain.sessions.user_context_chain_v4.RootBoundWorkChain>();
            let encoded = match (codec.encode)(value) {
                Ok(value) => value,
                Err(_) => abort("typed migration encoding failed")
            };
            let output = ExportRow {
                store = "nomo-user-context-chain-v4/Rows",
                key = entry.key,
                value = to_array(encoded)
            };
            println(
                match encode(output, "migration row conversion failed", "migration row encoding failed") {
                    Ok(value) => value,
                    Err(error) => abort(error)
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
