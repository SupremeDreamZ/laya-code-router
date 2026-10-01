import SwiftUI

/// Plan usage, drawn the way the Claude app draws it: a bar per limit window, how much is gone,
/// and when it comes back. Every number is the plan's own, read off the response headers; nothing
/// here is estimated except the optional pace line, which says so.
struct UsageCard: View {
    @ObservedObject var client: ControlClient
    /// Re-evaluated every 30s so a panel left open across a reset stops drawing the old window.
    @State private var now = Date()
    private let tick = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    private var snapshot: Snapshot { client.snapshot }
    private var thresholds: [Int] { snapshot.prefs.alertPrefs.thresholds }

    var body: some View {
        let windows = Usage.live(snapshot.limits, nowMs: now.timeIntervalSince1970 * 1000)
        VStack(alignment: .leading, spacing: Theme.Space.md) {
            SectionLabel("Plan usage", trailing: freshness)
            if windows.isEmpty {
                Text(client.live
                     ? "Asking Claude Code for your usage. It needs to be signed in with a Claude plan, and online."
                     : "Waiting for the router.")
                    .font(Theme.Face.micro)
                    .foregroundStyle(Theme.faint)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(windows, id: \.key) { item in
                    WindowRow(
                        name: Usage.windowName(item.key),
                        window: item.window,
                        thresholds: thresholds,
                        now: now,
                        showPace: snapshot.prefs.alertPrefs.pace
                    )
                }
            }
        }
        .padding(Theme.Space.md)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        .onReceive(tick) { now = $0 }
    }

    private var freshness: String? {
        guard let at = snapshot.limits?.at else { return nil }
        return Usage.age(ms: snapshot.now - at)
    }
}

private struct WindowRow: View {
    let name: String
    let window: Snapshot.LimitWindow
    let thresholds: [Int]
    let now: Date
    let showPace: Bool

    private var severity: Usage.Severity { Usage.severity(window.utilization, thresholds: thresholds) }
    private var pct: Int { Usage.percent(window.utilization) }

    private var tint: Color {
        switch severity {
        case .calm: Theme.accent
        case .warning: Theme.sonnet
        case .critical: Theme.opus
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(name)
                    .font(Theme.Face.label)
                    .foregroundStyle(Theme.inkSoft)
                Spacer(minLength: 0)
                // Colour is never the only signal: the figure itself is always there, and the
                // critical state adds a glyph.
                if severity == .critical {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(tint)
                }
                Text("\(pct)%")
                    .font(Theme.Face.figure)
                    .foregroundStyle(severity == .calm ? Theme.ink : tint)
            }
            Bar(fraction: min(1, window.utilization), tint: tint)
                .frame(height: 5)
            HStack(spacing: Theme.Space.sm) {
                if let reset = window.resetsAt {
                    let left = reset - now.timeIntervalSince1970 * 1000
                    Text("Resets \(Usage.resetLabel(resetsAt: reset, now: now)) · in \(Usage.countdown(ms: left))")
                        .font(Theme.Face.micro)
                        .foregroundStyle(Theme.faint)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            if showPace, let pace = window.pace {
                Text("At this pace it runs out in \(Usage.countdown(ms: pace.inMs)), before it resets. A guess from use so far.")
                    .font(Theme.Face.micro)
                    .foregroundStyle(Theme.sonnet)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name) limit, \(pct) percent used")
    }
}

/// The alerts that have fired recently, newest first. The panel shows these whether or not macOS
/// let the app post notifications, so a refused permission never hides a limit warning.
struct RecentAlerts: View {
    @ObservedObject var client: ControlClient

    var body: some View {
        let recent = client.snapshot.alertList.filter { $0.test != true }.suffix(3).reversed()
        if !recent.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Space.sm) {
                SectionLabel("Heads up")
                ForEach(Array(recent)) { a in
                    HStack(alignment: .top, spacing: Theme.Space.sm) {
                        Image(systemName: icon(a))
                            .font(.system(size: 11))
                            .foregroundStyle(color(a))
                            .frame(width: 14)
                            .padding(.top, 1)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.title)
                                .font(Theme.Face.label)
                                .foregroundStyle(Theme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(a.body)
                                .font(Theme.Face.micro)
                                .foregroundStyle(Theme.faint)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        Text(Usage.age(ms: client.snapshot.now - a.at))
                            .font(Theme.Face.micro)
                            .foregroundStyle(Theme.faint)
                    }
                }
            }
            .padding(Theme.Space.md)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func icon(_ a: Snapshot.Alert) -> String {
        switch a.kind {
        case "limit": "exclamationmark.octagon.fill"
        case "reset": "checkmark.circle.fill"
        case "pace": "gauge.with.dots.needle.67percent"
        default: "exclamationmark.triangle.fill"
        }
    }

    private func color(_ a: Snapshot.Alert) -> Color {
        switch a.level {
        case "critical": Theme.opus
        case "info": Theme.haiku
        default: Theme.sonnet
        }
    }
}
