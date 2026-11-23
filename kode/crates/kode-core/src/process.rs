//! Process-launch helpers shared by Kode's non-PTY child processes.

use std::process::Command as StdCommand;
use tokio::process::Command as TokioCommand;

/// Hide the console window Windows creates for console-subsystem children.
///
/// The installed GUI is a `windows_subsystem = "windows"` application. When it
/// launches commands such as `git`, `adb`, an agent CLI, or a sidecar, Windows
/// otherwise gives each console-subsystem child its own visible console window.
/// Apply this before configuring the rest of the command:
///
/// `Command::new(program).hide_console().args(args)`
///
/// PTY children are intentionally excluded because their terminal is managed by
/// `portable-pty`, not by this helper.
pub trait HideConsole: Sized {
    fn hide_console(self) -> Self;
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
impl HideConsole for StdCommand {
    fn hide_console(mut self) -> Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

#[cfg(not(windows))]
impl HideConsole for StdCommand {
    fn hide_console(self) -> Self {
        self
    }
}

#[cfg(windows)]
impl HideConsole for TokioCommand {
    fn hide_console(mut self) -> Self {
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

#[cfg(not(windows))]
impl HideConsole for TokioCommand {
    fn hide_console(self) -> Self {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hiding_console_preserves_std_command_configuration() {
        let mut command = StdCommand::new("git").hide_console();
        command.args(["--version"]);
        assert_eq!(command.get_program(), "git");
        assert_eq!(command.get_args().next().unwrap(), "--version");
    }

    #[test]
    fn hiding_console_preserves_tokio_command_configuration() {
        let mut command = TokioCommand::new("git").hide_console();
        command.args(["--version"]);
        assert_eq!(command.as_std().get_program(), "git");
        assert_eq!(command.as_std().get_args().next().unwrap(), "--version");
    }

    #[cfg(windows)]
    fn console_probe_script() -> &'static str {
        r#"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class KodeConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'; if ([KodeConsoleProbe]::GetConsoleWindow() -eq [IntPtr]::Zero) { [Console]::Out.Write("NO_CONSOLE") } else { [Console]::Out.Write("HAS_CONSOLE") }"#
    }

    #[cfg(windows)]
    #[test]
    fn hidden_std_command_has_no_console_window() {
        let output = StdCommand::new("powershell.exe")
            .hide_console()
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                console_probe_script(),
            ])
            .output()
            .expect("run hidden PowerShell probe");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "NO_CONSOLE");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn hidden_tokio_command_has_no_console_window() {
        let output = TokioCommand::new("powershell.exe")
            .hide_console()
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                console_probe_script(),
            ])
            .output()
            .await
            .expect("run hidden PowerShell probe");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "NO_CONSOLE");
    }
}
