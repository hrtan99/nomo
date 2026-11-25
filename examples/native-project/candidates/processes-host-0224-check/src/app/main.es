module app.main;
import nomo.adapters.command.processes.HostProcessControl;
import nomo.application.native.processes.ports.ProcessControl;
flow check<Live, C ~ ProcessControl<Live>>(control: C) -> string ![Command.start<DefaultCommandSandbox>] {
    return control.start(control.root(), "/usr/bin/python3", ["-V"]);
}
public flow main(args: Array<string>) -> i32 ![Command.start<DefaultCommandSandbox>] {
    check(HostProcessControl {});
    return 0;
}
