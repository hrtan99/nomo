module nomo.domain.execution.git;

public enum GitRequest {
    Status, Diff(bool, Array<string>), Log(i32), Branches, Init,
    Branch(string), Switch(string), Commit(string, Array<string>)
}
