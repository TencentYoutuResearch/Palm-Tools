use std::ffi::OsStr;
use std::process::Command;

#[cfg(windows)]
pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    Command::new(program)
}
