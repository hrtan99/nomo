module nomo.native.entry;

import std.io.{println, print, read_line};
import std.collections.len;
import std.text.trim;
import nomo.native.agent.{NativeCoding, ChatMessage, Turn};
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};

public flow run(args: Array<string>) -> i32
    ![Agentic, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<FileError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>] {
    if len(args) > 1 { abort("provide one request or no arguments for native chat"); }
    if len(args) == 1 {
        let answer = NativeCoding.run(Turn { request = args[0], history = [] });
        println(answer.text);
        return 0;
    }
    var history: Array<ChatMessage> = [];
    println("[NATIVE ] Nomo native chat · /help · /quit");
    while true limit Iterations(2147483647) {
        print("nomo> ");
        let raw = read_line();
        if raw == "" { return 0; }
        let request = trim(raw);
        if request == "/quit" || request == "/exit" { return 0; }
        if request == "" { continue; }
        if request == "/help" {
            println("Ask about the project; native tools provide Git status, file reads and approved replacement.");
            println("/history shows this process's conversation. /quit exits. Durable native sessions are still being migrated.");
            continue;
        }
        if request == "/history" {
            for message in history limit Iterations(2147483647) {
                println("[" + message.role + "] " + message.text);
            }
            continue;
        }
        let answer = NativeCoding.run(Turn { request = request, history = history });
        history = history.push(ChatMessage { role = "user", text = request });
        history = history.push(ChatMessage { role = "assistant", text = answer.text });
        println(answer.text);
    }
    return 0;
}
