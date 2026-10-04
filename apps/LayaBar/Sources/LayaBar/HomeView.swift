import SwiftUI

/// The main panel: is it on, what is it doing right now, and the one control that matters most.
struct HomeView: View {
    @ObservedObject var client: ControlClient

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.lg) {
                // First, and only while there is something to do: nothing routes until Claude Code
                // is signed in, so it comes before every control that assumes it is.
                AccountCard(account: client.snapshot.accountStatus, terminal: client.snapshot.prefs.launch.terminal)
                MasterToggle(snapshot: client.snapshot) { on in
                    client.update(.init(enabled: on))
                }
                if client.snapshot.prefs.enabled {
                    LiveNow(events: client.snapshot.events)
                } else {
                    PausedNote(tier: client.snapshot.prefs.pausedTier) { tier in
                        client.update(.init(pausedTier: tier))
                    }
                }
                UsageCard(client: client)
                RecentAlerts(client: client)
                Spend(usage: client.snapshot.usage, baseline: client.snapshot.prefs.baselineTier)
                QuickLaunch(client: client)
            }
            .padding(.horizontal, Theme.Space.panel)
            .padding(.top, Theme.Space.sm)
            .padding(.bottom, Theme.Space.lg)
        }
        .scrollIndicators(.never)
    }
}

/// One switch that turns routing on and off, styled as a physical control: the label says what
/// is happening in plain words, the switch is the only interactive part, and a press responds
/// immediately rather than waiting for the daemon's answer.
private struct MasterToggle: View {
    let snapshot: Snapshot
    let set: (Bool) -> Void
    @State private var pressed = false

    private var on: Bool { snapshot.prefs.enabled }

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(on ? "Routing on" : "Routing off")
                    .font(Theme.Face.title)
                    .foregroundStyle(on ? Theme.ink : Theme.inkSoft)
                Text(on ? "Each turn gets the cheapest model that can do it" : "Everything runs on \(Theme.label(snapshot.prefs.pausedTier))")
                    .font(Theme.Face.micro)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Theme.Space.sm)
            Toggle("", isOn: Binding(get: { on }, set: set))
                .labelsHidden()
                .toggleStyle(SwitchKnob())
        }
        .padding(Theme.Space.md)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        .scaleEffect(pressed ? 0.985 : 1)
        .animation(.spring(response: 0.22, dampingFraction: 0.8), value: pressed)
        .contentShape(Rectangle())
        .onTapGesture { set(!on) }
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in pressed = true }
                .onEnded { _ in pressed = false }
        )
    }
}

/// A switch that looks like a macOS switch but reads clearly on a dark panel.
struct SwitchKnob: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 0) {
            configuration.label.hidden()
            ZStack(alignment: configuration.isOn ? .trailing : .leading) {
                Capsule()
                    .fill(configuration.isOn ? Theme.accent : Theme.surfaceHi)
                    .frame(width: 42, height: 24)
                Circle()
                    .fill(Color(oklch: 0.98, 0.004, 80))
                    .frame(width: 20, height: 20)
                    .shadow(color: .black.opacity(0.4), radius: 1, y: 1)
                    .padding(.horizontal, 2)
            }
            .animation(.spring(response: 0.24, dampingFraction: 0.75), value: configuration.isOn)
        }
        .contentShape(Rectangle())
        .onTapGesture { configuration.isOn.toggle() }
    }
}

/// The most recent decision, at a glance: which model, how hard it was told to think, and what
/// you asked. This is the row that answers "why did it just do that?".
struct LiveNow: View {
    let events: [Snapshot.Event]

    private var latest: Snapshot.Event? { events.last }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            SectionLabel("Last decision", trailing: latest.map { rel($0.at) })
            if let e = latest {
                HStack(alignment: .top, spacing: Theme.Space.sm) {
                    Image(systemName: Theme.glyph(e.tier ?? ""))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.tier(e.tier))
                        .frame(width: 16)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: Theme.Space.sm) {
                            Text(Theme.label(e.tier ?? "?"))
                                .font(Theme.Face.label)
                                .foregroundStyle(Theme.tier(e.tier))
                            if let effort = e.effort {
                                Text(effort)
                                    .font(Theme.Face.micro)
                                    .foregroundStyle(Theme.muted)
                            }
                            Spacer(minLength: 0)
                            if let cost = cost(e) {
                                Text(cost)
                                    .font(Theme.Face.figure)
                                    .foregroundStyle(Theme.inkSoft)
                            }
                        }
                        if let p = e.prompt, !p.isEmpty {
                            Text(p)
                                .font(Theme.Face.micro)
                                .foregroundStyle(Theme.muted)
                                .lineLimit(2)
                        }
                        if let why = reasonLine(e.reason) {
                            Text(why)
                                .font(Theme.Face.micro)
                                .foregroundStyle(Theme.faint)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(Theme.Space.md)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
            } else {
                Text("No turns yet. Start a session and it will show up here.")
                    .font(Theme.Face.micro)
                    .foregroundStyle(Theme.faint)
                    .padding(Theme.Space.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    /// What one turn cost at list price. The daemon prices it (one table, tested); this only shows
    /// it. Small numbers are honest here (a few thousand cached tokens is cents), so they keep
    /// full precision rather than rounding to $0.00.
    private func cost(_ e: Snapshot.Event) -> String? {
        guard let total = e.cost else { return nil }
        return Money.short(total)
    }

    private func rel(_ at: Double) -> String {
        let s = max(0, Date().timeIntervalSince1970 - at / 1000)
        if s < 60 { return "just now" }
        if s < 3600 { return "\(Int(s / 60))m ago" }
        if s < 86400 { return "\(Int(s / 3600))h ago" }
        return "\(Int(s / 86400))d ago"
    }
}

/// Turns the router's internal reason into something a person would say out loud. The raw
/// values are useful in a log, not on a card someone glances at.
func reasonLine(_ reason: String?) -> String? {
    switch reason {
    case nil, "laya", "laya/no-change": return nil
    case "override": return "you asked for this one"
    case "ratchet-no-downgrade": return "kept this session on its strongest model"
    case "low-confidence-no-downgrade": return "not confident enough to go cheaper"
    case "low-confidence-capped": return "not confident enough to go stronger"
    case "laya-unavailable": return "Laya is not running, so nothing was routed"
    case "background": return "background work"
    case "manual": return "you picked this model"
    case "downgrade-not-worth-cache-rebuild": return "too much context to switch models"
    case "routing is off": return "routing is off"
    default:
        return reason?.hasSuffix("+unavailable") == true
            ? "that model is not available, so it stepped up"
            : nil
    }
}

/// While routing is off, say what everything is running on and let that be changed.
private struct PausedNote: View {
    let tier: String
    let set: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            SectionLabel("Running everything on")
            HStack(spacing: Theme.Space.sm) {
                ForEach(["haiku", "sonnet", "opus"], id: \.self) { name in
                    ChoiceChip(
                        label: Theme.label(name),
                        selected: tier == name,
                        tint: Theme.tier(name),
                        glyph: Theme.glyph(name)
                    ) { set(name) }
                }
            }
        }
    }
}

/// What today cost against what the same tokens would have cost on the baseline model. The
/// number is real: it is priced from the usage each response reported.
struct Spend: View {
    let usage: Snapshot.Usage
    let baseline: String

    private var saved: Double { max(0, usage.today.baseline - usage.today.cost) }
    private var pct: Double { usage.today.baseline > 0 ? saved / usage.today.baseline : 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            SectionLabel("Today", trailing: "\(usage.today.n) turn\(usage.today.n == 1 ? "" : "s")")
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.sm) {
                Text(String(format: "$%.2f", saved))
                    .font(Theme.Face.figureBig)
                    .foregroundStyle(Theme.accent)
                Text("saved")
                    .font(Theme.Face.label)
                    .foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
                if usage.today.n > 0 {
                    Text(String(format: "$%.2f spent", usage.today.cost))
                        .font(Theme.Face.figure)
                        .foregroundStyle(Theme.inkSoft)
                }
            }
            Bar(fraction: pct, tint: Theme.accent)
                .frame(height: 5)
            HStack(spacing: Theme.Space.sm) {
                Text(usage.today.n == 0 ? "Nothing routed yet today" : "against \(Theme.label(baseline)) at list price")
                    .font(Theme.Face.micro)
                    .foregroundStyle(Theme.faint)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let t = usage.today.trimmed, t > 0 {
                    Text("\(EventRow.tokens(t)) tokens trimmed")
                        .font(Theme.Face.micro)
                        .foregroundStyle(Theme.faint)
                        .lineLimit(1)
                        .help("Old tool results the API cleared from long prompts today, summed over requests")
                }
            }
            if usage.series.contains(where: { $0.n > 0 }) {
                Sparkline(points: usage.series.map { ($0.baseline - $0.cost) })
                    .frame(height: 26)
                    .padding(.top, 2)
            }
        }
        .padding(Theme.Space.md)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
    }
}

/// The launch button. Starting a session is the one thing a person does here most, so it is a
/// real button with the terminal and folder shown, not a menu item to hunt for.
struct QuickLaunch: View {
    @ObservedObject var client: ControlClient

    private var engine: String { client.snapshot.prefs.launch.engine }
    private var label: String { engine == "codex" ? "Codex" : "Claude Code" }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            SectionLabel("Start a session")
            // The label carries the fill itself and the whole thing is one tappable row, so no
            // AppKit button chrome can paint over it.
            Button {
                Launcher.launch(engine: engine, prefs: client.snapshot.prefs.launch)
            } label: {
                HStack(spacing: Theme.Space.sm) {
                    Image(systemName: "terminal.fill").font(.system(size: 12))
                    Text("New \(label) session")
                        .font(Theme.Face.label)
                    Spacer(minLength: 0)
                    Text(client.snapshot.prefs.launch.terminal)
                        .font(Theme.Face.micro)
                        .opacity(0.65)
                }
                .foregroundStyle(Color(oklch: 0.16, 0.02, 60))
                .padding(.horizontal, Theme.Space.md)
                .padding(.vertical, Theme.Space.sm + 1)
                .frame(maxWidth: .infinity)
                .background(Theme.accent, in: RoundedRectangle(cornerRadius: 9))
            }
            .buttonStyle(PressableStyle())
        }
    }
}

/// Shared bits. A section label, a chip, a bar, a sparkline, and the press feedback every
/// tappable thing shares.
struct SectionLabel: View {
    let text: String
    var trailing: String?

    init(_ text: String, trailing: String? = nil) {
        self.text = text
        self.trailing = trailing
    }

    var body: some View {
        HStack {
            Text(text.uppercased())
                .font(Theme.Face.micro)
                .tracking(0.09)
                .foregroundStyle(Theme.faint)
            Spacer(minLength: 0)
            if let trailing {
                Text(trailing)
                    .font(Theme.Face.micro)
                    .foregroundStyle(Theme.faint)
            }
        }
    }
}

struct ChoiceChip: View {
    let label: String
    let selected: Bool
    let tint: Color
    var glyph: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let glyph { Image(systemName: glyph).font(.system(size: 9)) }
                Text(label).font(Theme.Face.micro)
            }
            .padding(.horizontal, Theme.Space.sm)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity)
            .background(selected ? tint.opacity(0.18) : Theme.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? tint.opacity(0.55) : Theme.rule, lineWidth: 1))
            .foregroundStyle(selected ? tint : Theme.muted)
        }
        .buttonStyle(PressableStyle())
    }
}

struct Bar: View {
    let fraction: Double
    let tint: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.surfaceHi)
                Capsule()
                    .fill(tint)
                    .frame(width: max(3, geo.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: 5)
    }
}

/// A week of savings, one bar per day. Days with no traffic show a short hairline rather than a
/// gap, so "nothing happened" reads differently from "no data at all", and the whole strip is
/// scaled to its own best day so a single good day does not flatten the rest.
struct Sparkline: View {
    let points: [Double]

    /// Fixed bar width, not a fraction of the available width. A GeometryReader nested inside a
    /// height-only frame is unconstrained horizontally, so dividing by `size.width` there either
    /// collapses to a minimum or runs to infinity depending on the parent — either way one bar
    /// ends up filling the strip.
    private let barW: CGFloat = 14
    private let gap: CGFloat = 4

    var body: some View {
        GeometryReader { geo in
            let maxV = max(points.max() ?? 0, 0.01)
            HStack(alignment: .bottom, spacing: gap) {
                ForEach(Array(points.enumerated()), id: \.offset) { _, v in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(v > 0 ? Theme.accent.opacity(0.8) : Theme.rule.opacity(0.45))
                        .frame(width: barW, height: v > 0 ? max(3, geo.size.height * (v / maxV)) : 2)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}

/// Every control shrinks a hair on press and springs back. It is the whole microinteraction
/// budget: enough to feel physical, not enough to distract from the numbers.
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(.spring(response: 0.2, dampingFraction: 0.7), value: configuration.isPressed)
    }
}
