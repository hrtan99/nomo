module app.main;
import std.task.{run,race,Scheduler};
import std.host.command.{command,read,CommandEvent};
import std.host.command.start as spawn;
import std.fs.{Region,path,atomic_replace};
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.io.{println,read_line,IOError};
public type State;
impl State ~ Region;
flow main(args:Array<string>)->i32 ![Async,Console,Command.start<DefaultCommandSandbox>,Command.read<DefaultCommandSandbox>,Fs.atomic_replace<State>,Error<FileError>,Error<IOError>] {
 return run((scheduler:Scheduler)=> {
  let process=spawn(command("/usr/bin/python3",["-u","-c","import time; print('ready',flush=True); time.sleep(300)"]),DefaultCommandSandbox);
  match read(process,65536) {
   CommandEvent.Output(output,error)=> {
    let location=match path<State>("ready") {Ok(value)=>value,Err(_)=>{abort("fixture state unavailable");}};
    atomic_replace(location,output);
   },
   _=>{abort("fixture did not produce its ready event");}
  }
  return race<i32,IOError>([
   ()=> {read(process,65536);return 1;},
   ()=> {println("WAIT_INPUT");read_line();return 0;}
  ]);
 });
}
