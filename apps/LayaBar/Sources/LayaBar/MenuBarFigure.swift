import AppKit
import Foundation

/// What sits beside the menu-bar icon, decided in one place and drawn by the app delegate.
///
/// Three situations that used to look the same on screen are three different things here:
/// - **off**: the option is off, so nothing is drawn.
/// - **nothing to show yet**: the option is on, but the daemon holds no usable 5-hour reading. A dash
///   is drawn, dimmed, with a tooltip saying why. The daemon asks Claude Code for the figure every few
///   minutes, so this is a machine that is signed out, offline or only just started, and a reading
///   from a window that has ended is dropped on purpose. Drawing nothing here made the option look
///   broken (found on a real Mac, 2026-09-30).
/// - **a figure**: the whole percent, rounded down like everywhere else it appears.
struct MenuBarFigure: Equatable {
    var title: String
    var tooltip: String
    /// Dimmed when it is not a current reading: absent, or old enough that turns made without Laya
    /// may have moved it.
    var dimmed: Bool

    /// Past this age the reading may be out of date. The daemon asks again every five minutes, so a
    /// reading this old means the last few asks got no answer: Claude Code is offline or signed out.
    /// Use since then is not in it.
    static let staleAfterMs: Double = 15 * 60_000

    static let off = MenuBarFigure(title: "", tooltip: "Laya router", dimmed: false)

    /// Draws this on the status item's button. The only place the title, its colour and the tooltip
    /// are set, so a figure that was dimmed and then becomes current cannot keep its grey.
    @MainActor
    func apply(to button: NSButton) {
        if dimmed {
            // The menu-bar font is set explicitly: an attributed title with no font falls back to a
            // different typeface and the figure would change shape between the two states.
            button.attributedTitle = NSAttributedString(
                string: title,
                attributes: [.foregroundColor: NSColor.secondaryLabelColor, .font: NSFont.menuBarFont(ofSize: 0)]
            )
        } else {
            // A plain title follows the system's own menu-bar colour, light or dark. Setting it also
            // replaces any dimmed attributed title from before (measured on a real NSStatusBarButton,
            // for a number and for an empty string), so nothing needs clearing first.
            button.title = title
        }
        button.toolTip = tooltip
    }

    static func make(_ snapshot: Snapshot, live: Bool) -> MenuBarFigure {
        // Not live: before the first snapshot, or after the connection dropped, when the app still
        // holds the last snapshot but it is frozen. Neither is drawn.
        guard live, snapshot.prefs.menuBarUsage else { return .off }

        let current = Usage.live(snapshot.limits, nowMs: snapshot.now).first { $0.key == "5h" }?.window
        guard let current else {
            return MenuBarFigure(
                title: " –%",
                tooltip: "Laya · no 5-hour reading yet. It needs Claude Code signed in with a Claude plan, and a connection to Anthropic.",
                dimmed: true
            )
        }

        let pct = Usage.percent(current.utilization)
        var tooltip = "Laya · \(pct)% of your 5-hour limit used"
        var dimmed = false
        // A reading with no timestamp, or one stamped in the future by a skewed clock, has no age
        // to report. It is shown as current rather than guessed at.
        if let at = snapshot.limits?.at {
            let age = snapshot.now - at
            if age >= 60_000 { tooltip += ", as of \(Usage.countdown(ms: age)) ago" }
            if age >= staleAfterMs {
                dimmed = true
                tooltip += ". Laya couldn't refresh it, so it may be higher now."
            }
        }
        return MenuBarFigure(title: " \(pct)%", tooltip: tooltip, dimmed: dimmed)
    }
}

extension Snapshot {
    /// The same snapshot, judged at a later moment. The daemon pushes only when something changes, so
    /// a quiet one leaves the clock the figure is judged against where the last push stopped it. The
    /// app moves it forward, and never back: a clock a little behind the daemon's must not bring an
    /// ended window, or a stale reading, back to life.
    func advanced(to nowMs: Double) -> Snapshot {
        var copy = self
        copy.now = max(nowMs, now)
        return copy
    }
}
