module nomo.entry.recoverable_history_followup_check;

import std.effects.Fs;
import std.fs.IOError as FileError;
import std.io.IOError as ConsoleError;
import nomo.session.event_policy.PolicyRoot;
import nomo.entry.recoverable_history_check.run_mode;

public flow run(args: Array<string>) -> i32 ![Console, Memory, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] { return run_mode(args, true); }
