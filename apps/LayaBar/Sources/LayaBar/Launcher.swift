import AppKit
import SwiftUI

/// Starts a real terminal window running the routed CLI. Nothing here is simulated: it opens
/// the terminal a person already uses, in the folder they were last working in, with the
/// arguments `laya-claude` expects.
enum Terminals {
    /// The terminals worth offering, in the order most people have them. The id is what
    /// `open -a` understands; `args` is how to make it open a specific folder.
    struct Spec {
        let id: String
        let name: String
        let folderArgs: [String]
    }

    static let all: [Spec] = [
        .init(id: "terminal", name: "Terminal", folderArgs: []),
        .init(id: "iTerm", name: "iTerm", folderArgs: []),
        .init(id: "ghostty", name: "Ghostty", folderArgs: []),
        .init(id: "kitty", name: "kitty", folderArgs: ["--directory"]),
        .init(id: "warp", name: "Warp", folderArgs: []),
        .init(id: "alacritty", name: "Alacritty", folderArgs: ["--working-directory"]),
        .init(id: "WezTerm", name: "WezTerm", folderArgs: []),
    ]

    /// The ones worth showing: the ones actually installed, with Terminal always last as the
    /// fallback that is always there.
    static var common: [String] {
        let installed = all.filter { NSWorkspace.shared.urlForApplication(withBundleIdentifier: "") != nil && isInstalled($0.id) }.map(\.id)
        return installed.contains("terminal") ? installed : installed + ["terminal"]
    }

    static func label(_ id: String) -> String { all.first { $0.id == id }?.name ?? id }

    static func spec(_ id: String) -> Spec { all.first { $0.id == id } ?? all[0] }

    private static func isInstalled(_ bundle: String) -> Bool {
        NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: "/")) != nil
            && FileManager.default.fileExists(atPath: "/Applications/\(bundle).app")
            || FileManager.default.fileExists(atPath: "/System/Applications/\(bundle).app")
            || FileManager.default.fileExists(atPath: "/Applications/Utilities/\(bundle).app")
    }
}

enum Launcher {
    /// Opens a terminal running the routed CLI in `dir`.
    ///
    /// The command is the `laya-claude` shim already on PATH, so this is the same entry point a
    /// person would type by hand. `--continue` picks up the last session rather than starting
    /// over, which is what most people want when they open a second window.
    static func launch(engine: String, prefs: Snapshot.Prefs.Launch) {
        let bin = engine == "codex" ? "laya-codex" : "laya-claude"
        var command = bin
        if prefs.resume { command += engine == "codex" ? " resume --last" : " --continue" }
        open(commandLine(command, dir: prefs.dir), in: prefs.terminal, dir: prefs.dir)
    }

    /// Claude Code's own sign-in, in the person's terminal: they see the browser hand-off and any
    /// code it asks for, typed where Claude Code asks for it and nowhere near this app. Not run in
    /// the launch folder, which may no longer exist and would stop it from ever starting.
    static func signIn(terminal: String) {
        open(signInCommandLine, in: signInTerminal(preferred: terminal), dir: nil)
    }

    static let signInCommandLine = AccountStatus.loginCommand

    /// The terminals that take a command whether or not they are already running. The others are
    /// opened with arguments, which an app that is already open ignores, and a Sign in button that
    /// does nothing is the worst place for that. Terminal.app is always there.
    static let reliableTerminals = ["terminal", "iTerm", "kitty", "alacritty"]

    static func signInTerminal(preferred: String) -> String {
        reliableTerminals.contains(preferred) ? preferred : "terminal"
    }

    /// `cd` into the folder first when there is one. Quoted for a shell, since that is what reads it.
    static func commandLine(_ command: String, dir: String?) -> String {
        guard let dir, !dir.isEmpty else { return command }
        return "cd \(shellQuote(dir)) && \(command)"
    }

    /// The arguments for `osascript`, which takes each script as its own `-e`. They go to the
    /// program directly: a shell in between made a folder name with an apostrophe end the quoting
    /// early. Empty for a terminal that is not driven by AppleScript.
    static func appleScriptArguments(terminal: String, command: String) -> [String] {
        let quoted = escape(command)
        switch terminal {
        case "terminal":
            return ["-e", "tell application \"Terminal\" to do script \"\(quoted)\"", "-e", "tell application \"Terminal\" to activate"]
        case "iTerm":
            return ["-e", "tell application \"iTerm\" to create window with default profile command \"\(quoted)\"", "-e", "tell application \"iTerm\" to activate"]
        default:
            return []
        }
    }

    private static func open(_ command: String, in terminal: String, dir: String?) {
        let spec = Terminals.spec(terminal)
        let workspace = NSWorkspace.shared

        // Terminal and iTerm are driven by AppleScript; the rest take the folder as an argument
        // and the command after `-e`, which is the reliable way to get a command into a GUI
        // terminal without a profile.
        switch terminal {
        case "terminal", "iTerm":
            run("/usr/bin/osascript", appleScriptArguments(terminal: terminal, command: command))
        case "kitty":
            var args = ["/Applications/kitty.app/Contents/MacOS/kitty"]
            if let dir, !dir.isEmpty { args += ["--directory", dir] }
            args += [command]
            run(args[0], Array(args.dropFirst()))
        case "alacritty":
            var args = ["/Applications/Alacritty.app/Contents/MacOS/alacritty"]
            if let dir, !dir.isEmpty { args += ["--working-directory", dir] }
            args += ["-e", command]
            run(args[0], Array(args.dropFirst()))
        default:
            // Ghostty, Warp, WezTerm and anything new: let the OS open it, and if it supports a
            // command line, hand it one. Otherwise open the app and let the person paste.
            if workspace.urlForApplication(withBundleIdentifier: "") == nil,
               let url = URL(fileURLWithPath: "/Applications/\(spec.id).app") as URL?,
               FileManager.default.fileExists(atPath: url.path) {
                var args: [String] = []
                if let dir, !dir.isEmpty { args += spec.folderArgs + [dir] }
                args += ["-e", command]
                workspace.open(url, configuration: withArguments(args))
            } else if let url = workspace.urlForApplication(toOpen: URL(fileURLWithPath: "/")) {
                workspace.open(url)
            }
        }
    }

    private static func withArguments(_ args: [String]) -> NSWorkspace.OpenConfiguration {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.arguments = args
        return cfg
    }

    private static func run(_ executable: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = args
        try? p.run()
    }

    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }

    static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
