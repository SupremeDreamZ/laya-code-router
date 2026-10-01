import Foundation

/// Everything about usage that is arithmetic or wording rather than drawing. Kept free of SwiftUI
/// so it can be tested without a window, and so the panel, the menu-bar figure and the tests all
/// use one definition of "what percent" and "how long until".
enum Usage {
    enum Severity: Equatable {
        case calm, warning, critical
    }

    /// Whole percent, rounded down, matching the daemon's alert arithmetic exactly. Rounding to
    /// nearest would show 75% a moment before the 75% alert fires, which reads as a bug.
    static func percent(_ utilization: Double) -> Int {
        Int((utilization * 100 + 1e-9).rounded(.down))
    }

    /// How alarming a window looks. It follows the user's own alert thresholds: the bar turns to
    /// warning at the lowest, and to critical at the highest (never earlier than 90%). Setting a
    /// single alert at 50% must not paint a half-full bar red.
    static func severity(_ utilization: Double, thresholds: [Int]) -> Severity {
        let pct = percent(utilization)
        // The bar is a display, not an alert: it stays honest whatever the user has muted. Near
        // the top it is critical even with every threshold removed.
        if pct >= max(thresholds.max() ?? 90, 90) { return .critical }
        if let low = thresholds.min(), pct >= low { return .warning }
        return .calm
    }

    /// "45 min", "3 h 12 min", "2 days". Never "0": a window about to reset says "now".
    static func countdown(ms: Double) -> String {
        if ms <= 0 { return "now" }
        let minutes = max(1, Int((ms / 60_000).rounded()))
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let rest = minutes % 60
        if hours >= 24 {
            let days = Int((Double(hours) / 24).rounded())
            return days == 1 ? "1 day" : "\(days) days"
        }
        return rest == 0 ? "\(hours) h" : "\(hours) h \(rest) min"
    }

    /// "5:30 PM" when it resets today, "Thu 12:00 AM" otherwise.
    static func resetLabel(
        resetsAt ms: Double,
        now: Date,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let f = DateFormatter()
        f.locale = locale
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.setLocalizedDateFormatFromTemplate(calendar.isDate(date, inSameDayAs: now) ? "jm" : "EEEjm")
        return f.string(from: date)
    }

    /// Plain names for the windows the plan reports. A window we have no name for keeps its own
    /// key rather than a guess: "7d_oi" appeared on a Fable request and its meaning is not
    /// documented, so it is shown as reported, not explained.
    static func windowName(_ key: String) -> String {
        switch key {
        case "5h": return "5-hour"
        case "7d": return "Weekly"
        default:
            let parts = key.split(separator: "_", maxSplits: 1).map(String.init)
            guard parts.count == 2, let base = parts.first else { return key }
            let head = base == "5h" ? "5-hour" : base == "7d" ? "Weekly" : base
            return "\(head) · \(parts[1])"
        }
    }

    /// The windows worth drawing right now: ordered, and without any whose reset moment has
    /// passed. The daemon drops expired windows too, but it only pushes when something happens, so
    /// a panel left open across a reset would keep showing a full bar for a window that is over.
    static func live(_ limits: Snapshot.Limits?, nowMs: Double) -> [(key: String, window: Snapshot.LimitWindow)] {
        guard let limits else { return [] }
        return orderedWindows(limits).filter { ($0.window.resetsAt ?? .infinity) > nowMs }
    }

    /// "just now", "4 min ago", "3 h ago". A clock a little behind the daemon's is not the future.
    static func age(ms: Double) -> String {
        if ms < 60_000 { return "just now" }
        return "\(countdown(ms: ms)) ago"
    }

    /// A session counts as running for five minutes after its last turn. It is what decides
    /// whether quitting needs a second tap, so it errs toward asking.
    static func recentlyActive(lastEventAt: Double?, nowMs: Double) -> Bool {
        guard let lastEventAt else { return false }
        return nowMs - lastEventAt < 5 * 60_000
    }

    /// Windows in the order a person looks for them: 5-hour, weekly, then anything else.
    static func orderedWindows(_ limits: Snapshot.Limits) -> [(key: String, window: Snapshot.LimitWindow)] {
        var out: [(key: String, window: Snapshot.LimitWindow)] = []
        if let w = limits.fiveHour { out.append(("5h", w)) }
        if let w = limits.weekly { out.append(("7d", w)) }
        out.append(contentsOf: limits.other.map { (key: $0.key, window: $0.window) })
        return out
    }
}

/// Decides which alerts are new. The daemon keeps the history; the app only has to notify about
/// what it has not shown. The first snapshot after launch just records what is already there, so
/// reopening the app never replays yesterday's alerts.
struct AlertFeed {
    private(set) var seen: Set<String> = []
    private(set) var primed = false
    private let cap = 400

    /// `live` is false until a real snapshot has arrived from the daemon. The app starts with an
    /// empty placeholder, and priming on that would make the first real snapshot look like a flood
    /// of new alerts, replaying the daemon's whole history as notifications.
    mutating func fresh(_ alerts: [Snapshot.Alert], live: Bool = true) -> [Snapshot.Alert] {
        guard live else { return [] }
        defer { primed = true }
        let new = alerts.filter { !seen.contains($0.id) }
        seen.formUnion(new.map(\.id))
        // The set only needs to outlive the daemon's own log (30 entries); trimming it keeps a
        // long-running app from growing without bound.
        if seen.count > cap { seen = Set(alerts.map(\.id)) }
        return primed ? new : []
    }
}

/// How long to wait before trying the daemon again: quick at first, because a restart usually
/// takes a second or two, then settling so a daemon that is really gone is not hammered.
struct Backoff {
    private(set) var attempt = 0
    static let first = 0.5
    static let ceiling = 15.0

    mutating func next() -> Double {
        defer { attempt += 1 }
        return min(Backoff.ceiling, Backoff.first * pow(2, Double(min(attempt, 20))))
    }

    mutating func reset() { attempt = 0 }
}

enum Money {
    /// "$0.02" from a cent up, "$0.0068" below it, so a cheap turn is not shown as free.
    static func short(_ dollars: Double) -> String {
        dollars >= 0.01 ? String(format: "$%.2f", dollars) : String(format: "$%.4f", dollars)
    }
}
