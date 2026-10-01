import Foundation

/// Starts the background router when the app finds it not running. The router is a launchd job;
/// this only asks launchd to start it, so the app can be opened on its own (after a "Quit Laya",
/// or on a machine where the login item has not started yet) and bring the router up with it.
enum DaemonControl {
    /// Must match the `Label` install.sh writes into the LaunchAgent. A test checks that it does.
    static let label = "io.github.supremedreamz.laya"

    static var plistPath: String { NSHomeDirectory() + "/Library/LaunchAgents/\(label).plist" }

    static func kickstart(uid: uid_t) -> [String] { ["kickstart", "gui/\(uid)/\(label)"] }
    static func bootstrap(uid: uid_t, plist: String) -> [String] { ["bootstrap", "gui/\(uid)", plist] }

    /// Asks launchd to start the router if it is not already running. `kickstart` without `-k`
    /// leaves a running job alone, so calling this when it is up does nothing. If launchd has never
    /// heard of the job (the plist exists but was never loaded) it is loaded first.
    static func ensureRunning() {
        Task.detached(priority: .utility) {
            let uid = getuid()
            if run(kickstart(uid: uid)) != 0, FileManager.default.fileExists(atPath: plistPath) {
                _ = run(bootstrap(uid: uid, plist: plistPath))
                _ = run(kickstart(uid: uid))
            }
        }
    }

    @discardableResult
    private static func run(_ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }
}
