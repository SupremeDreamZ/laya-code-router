import Foundation

/// What the router card and the status dot say, derived from the daemon's own report.
///
/// Two separate facts were being treated as one. The *proxy* is the local address sessions talk to;
/// the *model* is the routing model that decides each turn. A proxy can be up with no model loaded,
/// or with one that failed to start (measured with a Python that had no `laya` package: the card
/// read "Running - Warm model in memory" throughout). Only `warm` means the model answered.
struct RouterStatus: Equatable {
    var sidecar: Snapshot.Sidecar
    var proxyRunning: Bool
    /// Claude Code's sign-in. Nothing routes until it is signed in, so a "ready" dot beside a
    /// signed-out Claude Code would be the same false comfort as a "warm" model that never loaded.
    var account: AccountStatus = .unknown

    enum Dot: Equatable {
        case ready, loading, failed, idle, off, attention

        /// What VoiceOver reads, so the dot is never colour-only.
        var accessibilityLabel: String {
            switch self {
            case .ready: "Routing is ready"
            case .loading: "Loading the routing model"
            case .failed: "Routing is not working"
            case .idle: "Waiting for your first turn"
            case .off: "Routing is off"
            case .attention: "Claude Code needs attention"
            }
        }

        /// Drawn larger and ringed: the two states that need something from the person.
        var isLoud: Bool { self == .failed || self == .attention }
    }

    var dot: Dot {
        guard proxyRunning else { return .off }
        if account.needsAttention { return .attention }
        switch sidecar.state {
        case "warm": return .ready
        case "starting": return .loading
        case "error": return .failed
        default: return .idle
        }
    }

    /// Paused routing is paused whatever state the model is in.
    func dot(routingOn: Bool) -> Dot { routingOn ? dot : .off }

    /// The words behind the dot: the specific reason when it needs attention, else its own label.
    func help(routingOn: Bool) -> String {
        let shown = dot(routingOn: routingOn)
        return shown == .attention ? account.headline : shown.accessibilityLabel
    }

    var headline: String {
        guard proxyRunning else { return "Stopped" }
        switch sidecar.state {
        case "warm": return "Ready"
        case "starting": return "Loading the routing model"
        case "error": return "Routing is not working"
        default: return "Waiting for your first turn"
        }
    }

    var detail: String {
        guard proxyRunning else { return "Sessions are not being routed. Start it to route them." }
        switch sidecar.state {
        case "warm": return "The routing model is loaded and ready for the next turn."
        case "starting": return "The first load takes up to a minute. Your turn is not held up: it runs on its current model meanwhile."
        case "error": return "Turns still run, on the model they were already using."
        default: return "The routing model loads on the first turn, which can take a minute."
        }
    }

    /// The daemon's own explanation of what went wrong, or nil when nothing has.
    var problem: String? {
        guard proxyRunning, sidecar.state == "error" else { return nil }
        let text = sidecar.lastError?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? "The routing model failed to start, and no reason was given. See ~/.laya-router/daemon.log." : text
    }

    /// The button follows the proxy, which is what it actually starts and stops. Title and action
    /// come from the same flag here, so a label can never promise one thing and do the other.
    var buttonTitle: String { proxyRunning ? "Stop" : "Start" }
    var buttonStops: Bool { proxyRunning }
}
