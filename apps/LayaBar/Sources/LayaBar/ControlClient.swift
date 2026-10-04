import Foundation
import Network
import SwiftUI

/// Everything the daemon tells the UI, decoded. `Decodable` rather than a hand-rolled parser so
/// a field the daemon adds later is ignored instead of crashing the panel, and every field the
/// UI reads has a default so an older daemon still shows something sensible.
struct Snapshot: Decodable, Equatable {
    struct Prefs: Decodable, Equatable {
        struct Tiers: Decodable, Equatable {
            var haiku: Bool
            var sonnet: Bool
            var opus: Bool
            var fable: Bool
        }
        struct Launch: Decodable, Equatable {
            var engine: String
            var terminal: String
            var resume: Bool
            var dir: String?
        }
        struct Alerts: Decodable, Equatable {
            struct Windows: Decodable, Equatable {
                var fiveHour: Bool
                var weekly: Bool
            }
            var enabled: Bool
            var thresholds: [Int]
            var limit: Bool
            var reset: Bool
            var pace: Bool
            var windows: Windows

            static let standard = Alerts(
                enabled: true, thresholds: [75, 90], limit: true, reset: true, pace: false,
                windows: .init(fiveHour: true, weekly: true)
            )
        }
        var enabled: Bool
        var preset: String
        var tiers: Tiers
        var effortAuto: Bool
        var pausedTier: String
        var baselineTier: String
        var showPrompts: Bool
        var launch: Launch
        // Optional so a daemon from before alerts existed still decodes; the UI reads `alertPrefs`.
        var alerts: Alerts?
        var showUsageInMenuBar: Bool?
        /// Optional so an older daemon still decodes; absent means on, the daemon's default.
        var trimToolResults: Bool?
        var guard_: Bool?
        var rankFiles: Bool?
        var routeSubagents: Bool?

        enum CodingKeys: String, CodingKey {
            case enabled, preset, tiers, effortAuto, pausedTier, baselineTier, showPrompts, launch, alerts
            case showUsageInMenuBar, trimToolResults, rankFiles, routeSubagents
            case guard_ = "guard"
        }

        var trimOn: Bool { trimToolResults ?? true }
        var guardOn: Bool { guard_ ?? false }
        var rankFilesOn: Bool { rankFiles ?? false }
        var routeSubagentsOn: Bool { routeSubagents ?? true }
        var alertPrefs: Alerts { alerts ?? .standard }
        var menuBarUsage: Bool { showUsageInMenuBar ?? false }

        func tier(_ name: String) -> Bool {
            switch name {
            case "haiku": tiers.haiku
            case "sonnet": tiers.sonnet
            case "opus": tiers.opus
            case "fable": tiers.fable
            default: false
            }
        }

        /// A patch for one tier, so a row can be toggled without sending the whole object.
        func toggling(_ name: String) -> Snapshot.PrefsPatch {
            .init(tiers: [name: !tier(name)])
        }
    }

    struct PrefsPatch: Encodable {
        var enabled: Bool?
        var preset: String?
        var tiers: [String: Bool]?
        var effortAuto: Bool?
        var pausedTier: String?
        var baselineTier: String?
        var showPrompts: Bool?
        var launch: LaunchPatch?
        var alerts: AlertsPatch?
        var showUsageInMenuBar: Bool?
        var trimToolResults: Bool?
        var guard_: Bool?
        var rankFiles: Bool?
        var routeSubagents: Bool?

        enum CodingKeys: String, CodingKey {
            case enabled, preset, tiers, effortAuto, pausedTier, baselineTier, showPrompts, launch, alerts
            case showUsageInMenuBar, trimToolResults, rankFiles, routeSubagents
            case guard_ = "guard"
        }

        struct AlertsPatch: Encodable {
            struct WindowsPatch: Encodable {
                var fiveHour: Bool?
                var weekly: Bool?
            }
            var enabled: Bool?
            var thresholds: [Int]?
            var limit: Bool?
            var reset: Bool?
            var pace: Bool?
            var windows: WindowsPatch?
        }

        struct LaunchPatch: Encodable {
            var engine: String?
            var terminal: String?
            var resume: Bool?
            var dir: String??
        }
    }

    struct Engine: Decodable, Equatable {
        var running: Bool
        var port: Int
        var sessions: Int
        var startedAt: Double?
    }

    struct Sidecar: Decodable, Equatable {
        var state: String
        var since: Double?
        var lastError: String?
    }

    struct Usage: Decodable, Equatable {
        struct Day: Decodable, Equatable {
            struct TierTotals: Decodable, Equatable {
                var n: Int
                var input: Double
                var cacheWrite: Double
                var cacheRead: Double
                var output: Double
                var cost: Double
            }
            var n: Int
            var cost: Double
            var baseline: Double
            var byTier: [String: TierTotals]?
            /// Prompt tokens trimmed today (old tool results). Absent from an older daemon.
            var trimmed: Double?
        }
        struct Point: Decodable, Equatable {
            var date: String
            var n: Int
            var cost: Double
            var baseline: Double
        }
        struct Totals: Decodable, Equatable {
            var n: Int
            var cost: Double
            var baseline: Double
        }
        var today: Day
        var series: [Point]
        var all: Totals
    }

    /// One rate-limit window as the plan reports it. `utilization` is a fraction; it can pass 1.
    struct LimitWindow: Decodable, Equatable {
        struct Pace: Decodable, Equatable {
            var inMs: Double
            var atMs: Double
        }
        var utilization: Double
        var resetsAt: Double?
        var status: String?
        var pace: Pace?
    }

    struct Limits: Decodable, Equatable {
        var windows: [String: LimitWindow]
        var status: String?
        var representative: String?
        var at: Double?

        var fiveHour: LimitWindow? { windows["5h"] }
        var weekly: LimitWindow? { windows["7d"] }

        /// Windows other than the two the plan documents, e.g. the one seen on a Fable request.
        var other: [(key: String, window: LimitWindow)] {
            windows.filter { $0.key != "5h" && $0.key != "7d" }.sorted { $0.key < $1.key }.map { (key: $0.key, window: $0.value) }
        }

        static func == (a: Limits, b: Limits) -> Bool {
            a.windows == b.windows && a.status == b.status && a.representative == b.representative
        }
    }

    struct Alert: Decodable, Equatable, Identifiable {
        var id: String
        var at: Double
        var kind: String
        var level: String
        var window: String?
        var threshold: Int?
        var pct: Int?
        var title: String
        var body: String
        var test: Bool?
    }

    struct Model: Decodable, Equatable {
        var tier: String
        var id: String
        var thinking: Bool
        var effort: Bool
    }

    struct Event: Decodable, Equatable, Identifiable {
        var at: Double
        var kind: String
        var tier: String?
        var model: String?
        var effort: String?
        var reason: String?
        var prompt: String?
        var ms: Double?
        var confidence: Double?
        var usage: TokenUse?
        /// What this turn cost at list price, priced by the daemon. Absent when usage was not read.
        var cost: Double?
        var session: String?
        /// Old tool results the API cleared from this request's prompt, when trimming applied.
        var cleared: Cleared?

        var id: String { "\(at)-\(model ?? "")-\(tier ?? "")" }

        struct Cleared: Decodable, Equatable {
            var tokens: Double
            var toolUses: Double
        }

        struct TokenUse: Decodable, Equatable {
            var input: Double
            var cacheWrite: Double
            var cacheRead: Double
            var output: Double
        }
    }

    var prefs: Prefs
    var engines: [String: Engine]
    var sidecar: Sidecar
    var tiers: [String]
    var usage: Usage
    var models: [Model]
    var events: [Event]
    var now: Double
    var limits: Limits?
    var alerts: [Alert]?
    /// Absent from a daemon older than this field, which is "not known", not "signed out".
    var account: AccountStatus?

    var alertList: [Alert] { alerts ?? [] }

    var claudeRunning: Bool { engines["claude"]?.running ?? false }
    var anyRunning: Bool { engines.values.contains { $0.running } }

    var accountStatus: AccountStatus { account ?? .unknown }

    /// The one place "is it working" is decided, so the dot and the Router card can never disagree.
    var router: RouterStatus { RouterStatus(sidecar: sidecar, proxyRunning: anyRunning, account: accountStatus) }

    static let empty = Snapshot(
        prefs: .init(
            enabled: true, preset: "balanced",
            tiers: .init(haiku: true, sonnet: true, opus: true, fable: false),
            effortAuto: true, pausedTier: "opus", baselineTier: "opus", showPrompts: true,
            launch: .init(engine: "claude", terminal: "terminal", resume: false, dir: nil)
        ),
        engines: [:],
        sidecar: .init(state: "stopped", since: nil, lastError: nil),
        tiers: ["haiku", "sonnet", "opus"],
        usage: .init(today: .init(n: 0, cost: 0, baseline: 0, byTier: nil), series: [], all: .init(n: 0, cost: 0, baseline: 0)),
        models: [],
        events: [],
        now: 0,
        limits: nil,
        alerts: [],
        account: nil
    )
}

/// Talks to the daemon over its 127.0.0.1 socket. One long-lived connection carries every
/// change, so the panel never opens a second socket per keystroke, and a dropped connection is
/// retried rather than left to fail silently in the background.
@MainActor
final class ControlClient: ObservableObject {
    @Published private(set) var snapshot: Snapshot = .empty
    @Published private(set) var connected = false
    /// True once a real snapshot has arrived from the daemon. Until then the panel shows an empty
    /// placeholder, and nothing that depends on real data (notifications) should act on it.
    @Published private(set) var live = false
    @Published private(set) var lastError: String?

    private var socket: NWConnection?
    private var buffer = Data()
    private var nextId = 1
    private var pending: [Int: (Result<Snapshot?, Error>) -> Void] = [:]
    private var token: String?
    private var task: Task<Void, Never>?

    /// Where the daemon writes its run file, and the home it reads prefs from.
    static let runFile: URL = {
        let home = ProcessInfo.processInfo.environment["LAYA_HOME"]
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".laya-router").path
        return URL(fileURLWithPath: home).appendingPathComponent("run.json")
    }()

    /// Keeps the connection alive for as long as the app runs. The daemon restarts (an update, a
    /// crash, the user quitting and reopening it) and gets a new port and token each time; a client
    /// that connects once would sit on "Not connected" forever. This notices, waits a little
    /// longer each time it fails, and re-reads the run file on every attempt.
    func connect() {
        guard task == nil else { return }
        task = Task { [weak self] in
            var backoff = Backoff()
            while !Task.isCancelled {
                guard let self else { return }
                if self.socket == nil {
                    await self.open()
                    // A busy machine can take a couple of seconds to complete a loopback
                    // connection; judging it after a fraction of a second would cancel a
                    // connection that was about to succeed, and flap.
                    for _ in 0..<30 where self.socket != nil && !self.connected {
                        try? await Task.sleep(for: .milliseconds(100))
                    }
                    if self.connected {
                        backoff.reset()
                    } else {
                        self.drop(self.socket)
                        try? await Task.sleep(for: .seconds(backoff.next()))
                    }
                } else {
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
    }

    /// Tears down a connection that is gone or never came up. Idempotent, and ignores a stale
    /// connection that has already been replaced by a newer one.
    private func drop(_ conn: NWConnection?) {
        guard let conn, conn === socket else { return }
        conn.stateUpdateHandler = nil
        conn.cancel()
        socket = nil
        connected = false
        live = false
        buffer.removeAll()
        let waiting = pending
        pending.removeAll()
        waiting.values.forEach { $0(.failure(ControlError.down)) }
    }

    private func readRunInfo() -> (port: UInt16, token: String)? {
        guard let data = try? Data(contentsOf: Self.runFile),
              let info = try? JSONDecoder().decode(RunInfo.self, from: data) else { return nil }
        return (info.port, info.token)
    }

    private struct RunInfo: Decodable {
        var token: String
        var port: UInt16
        var pid: Int32
        var startedAt: Double
        var root: String
    }

    private func open() async {
        guard let (port, token) = readRunInfo() else {
            lastError = "Laya is not running."
            connected = false
            return
        }
        self.token = token
        let conn = NWConnection(host: .ipv4(.loopback), port: .init(rawValue: port) ?? 8790, using: .tcp)
        socket = conn
        conn.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .ready:
                    self.connected = true
                    self.lastError = nil
                    Task { _ = try? await self.send(action: "subscribe", arg: nil, needsToken: true) }
                case .failed, .cancelled:
                    self.drop(conn)
                case .waiting:
                    // "Waiting" is where a refused connection sits, politely retrying forever. The
                    // supervisor does its own, better-paced retrying, so give up on this one.
                    self.drop(conn)
                default:
                    break
                }
            }
        }
        conn.start(queue: .global(qos: .userInitiated))
        receive(on: conn)
        // No separate snapshot request: subscribing answers with the current state straight away,
        // and awaiting a reply here would hold the reconnect loop hostage to a daemon that accepts
        // the connection and then never speaks.
    }

    private func receive(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            Task { @MainActor in
                guard let self else { return }
                if let data { self.buffer.append(data) }
                if error != nil || isComplete {
                    self.drop(conn)
                    return
                }
                self.drain()
                self.receive(on: conn)
            }
        }
    }

    private func drain() {
        while let idx = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<idx]
            buffer.removeSubrange(buffer.startIndex...idx)
            guard let reply = Wire.parse(Data(line)) else { continue }
            handle(reply)
        }
    }

    private func handle(_ reply: Reply) {
        if let snap = reply.snapshot {
            snapshot = snap
            live = true
            lastError = nil
        }
        if let err = reply.error { lastError = err }
        // Every reply releases the request that asked for it, whatever it holds. A reply with no
        // snapshot (a pong, a single alert) used to be dropped and its request waited forever.
        if let id = reply.id, let waiter = pending.removeValue(forKey: id) {
            if let err = reply.error { waiter(.failure(ControlError.rejected(err))) }
            else { waiter(.success(reply.snapshot)) }
        }
    }

    @discardableResult
    private func send(action: String, arg: (any Encodable)?, needsToken: Bool) async throws -> Snapshot? {
        guard let socket else { throw ControlError.down }
        let id = nextId
        nextId += 1
        var payload: [String: Any] = ["id": id, "action": action]
        if needsToken, let token { payload["token"] = token }
        if let arg {
            payload["arg"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AnyEncodable(arg)))
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        socket.send(content: data + Data([0x0A]), completion: .contentProcessed { _ in })
        return try await withCheckedThrowingContinuation { cont in
            pending[id] = { cont.resume(with: $0) }
        }
    }

    private struct AnyEncodable: Encodable {
        private let encodeFunc: (Encoder) throws -> Void
        init(_ wrapped: any Encodable) { encodeFunc = { try wrapped.encode(to: $0) } }
        func encode(to encoder: Encoder) throws { try encodeFunc(encoder) }
    }

    enum ControlError: LocalizedError {
        case down, rejected(String)
        var errorDescription: String? {
            switch self {
            case .down: "Laya is not running."
            case .rejected(let m): m
            }
        }
    }

    // MARK: - Commands

    func update(_ patch: Snapshot.PrefsPatch) {
        Task { _ = try? await send(action: "prefs.update", arg: patch, needsToken: true) }
    }

    func startEngine(_ engine: String) {
        Task { _ = try? await send(action: "engine.start", arg: ["engine": engine], needsToken: true) }
    }

    func stopEngine(_ engine: String) {
        Task { _ = try? await send(action: "engine.stop", arg: ["engine": engine], needsToken: true) }
    }

    func resetUsage() {
        Task { _ = try? await send(action: "usage.reset", arg: Optional<String>.none, needsToken: true) }
    }

    /// Stops the background router. With `thenQuit`, waits for the reply (the daemon answers before
    /// it exits) so the request is really on the wire before this app goes away.
    func quitDaemon(thenQuit: Bool = false) {
        Task {
            _ = try? await send(action: "quit", arg: Optional<String>.none, needsToken: true)
            if thenQuit { NSApp.terminate(nil) }
        }
    }

    func testAlert() {
        Task { _ = try? await send(action: "alerts.test", arg: Optional<String>.none, needsToken: true) }
    }
}
