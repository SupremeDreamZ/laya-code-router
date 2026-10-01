import SwiftUI

/// Everything about usage alerts, in one place: whether they are on, at what levels, for which
/// windows, and a button that proves they reach the screen. The daemon decides when to alert; these
/// controls only change its settings.
struct AlertSettings: View {
    @ObservedObject var client: ControlClient
    /// What macOS says about notifications for this app. `.allowed` until told otherwise, so the
    /// warning never flashes up before the app has had a chance to ask.
    var access: NotifyAccess = .allowed
    var recheck: () -> Void = {}

    private var alerts: Snapshot.Prefs.Alerts { client.snapshot.prefs.alertPrefs }
    private var menuBarFigure: Bool { client.snapshot.prefs.menuBarUsage }

    /// The levels offered as chips. Custom levels cannot be typed in a menu-bar panel, so a fixed
    /// set covers the useful range; the daemon accepts any whole percent if set another way.
    private let levels = [50, 60, 70, 75, 80, 85, 90, 95]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            SectionLabel("Usage alerts")

            ToggleRow(
                icon: "bell.badge",
                title: "Warn me about my limits",
                subtitle: "A notification as a 5-hour or weekly limit fills up, and when it resets.",
                set: { client.update(.init(alerts: .init(enabled: $0))) },
                isOn: alerts.enabled
            )

            if let message = access.message {
                HStack(alignment: .top, spacing: Theme.Space.sm) {
                    Image(systemName: "bell.slash")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.sonnet)
                        .padding(.top, 1)
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        Text(message)
                            .font(Theme.Face.micro)
                            .foregroundStyle(Theme.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)
                        if access.canOpenSettings {
                            Button {
                                if let url = URL(string: NotifyAccess.settingsURL) { NSWorkspace.shared.open(url) }
                            } label: {
                                Text("Open Notification Settings").font(Theme.Face.label).foregroundStyle(Theme.accent)
                            }
                            .buttonStyle(PressableStyle())
                        }
                    }
                }
                .padding(.horizontal, Theme.Space.md)
                .padding(.vertical, Theme.Space.sm + 2)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Theme.sonnet.opacity(0.35), lineWidth: 1))
            }

            if alerts.enabled {
                VStack(alignment: .leading, spacing: Theme.Space.sm) {
                    Text("Warn me at")
                        .font(Theme.Face.micro)
                        .foregroundStyle(Theme.faint)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Theme.Space.xs), count: 4), spacing: Theme.Space.xs) {
                        ForEach(levels, id: \.self) { level in
                            ChoiceChip(
                                label: "\(level)%",
                                selected: alerts.thresholds.contains(level),
                                tint: Theme.accent
                            ) { client.update(.init(alerts: .init(thresholds: toggled(level)))) }
                        }
                    }
                    if alerts.thresholds.isEmpty {
                        Text("No levels chosen. You will still hear when a limit is hit and when it resets.")
                            .font(Theme.Face.micro)
                            .foregroundStyle(Theme.faint)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, Theme.Space.md)
                .padding(.vertical, Theme.Space.sm + 2)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 9))

                ToggleRow(
                    icon: "clock",
                    title: "5-hour limit",
                    subtitle: "",
                    set: { client.update(.init(alerts: .init(windows: .init(fiveHour: $0)))) },
                    isOn: alerts.windows.fiveHour
                )
                ToggleRow(
                    icon: "calendar",
                    title: "Weekly limit",
                    subtitle: "",
                    set: { client.update(.init(alerts: .init(windows: .init(weekly: $0)))) },
                    isOn: alerts.windows.weekly
                )
                ToggleRow(
                    icon: "exclamationmark.octagon",
                    title: "When I hit a limit",
                    subtitle: "Always worth knowing. Muting a window above does not hide this.",
                    set: { client.update(.init(alerts: .init(limit: $0))) },
                    isOn: alerts.limit
                )
                ToggleRow(
                    icon: "checkmark.circle",
                    title: "When it resets",
                    subtitle: "Only after a limit you actually hit.",
                    set: { client.update(.init(alerts: .init(reset: $0))) },
                    isOn: alerts.reset
                )
                ToggleRow(
                    icon: "gauge.with.dots.needle.67percent",
                    title: "Warn if I am on pace to run out",
                    subtitle: "A guess from use so far, so it can be wrong. Off by default.",
                    set: { client.update(.init(alerts: .init(pace: $0))) },
                    isOn: alerts.pace
                )

                Button { client.testAlert(); recheck() } label: {
                    HStack(spacing: Theme.Space.sm) {
                        Image(systemName: "bell").font(.system(size: 11))
                        Text("Send a test alert").font(Theme.Face.label)
                    }
                    .foregroundStyle(Theme.accent)
                }
                .buttonStyle(PressableStyle())
                .padding(.top, Theme.Space.xs)
            }

            ToggleRow(
                icon: "menubar.rectangle",
                title: "Show usage in the menu bar",
                subtitle: "The 5-hour figure next to the icon.",
                set: { client.update(.init(showUsageInMenuBar: $0)) },
                isOn: menuBarFigure
            )
        }
    }

    /// The chosen levels with `level` added or removed, sorted, as the daemon stores them.
    private func toggled(_ level: Int) -> [Int] {
        var set = Set(alerts.thresholds)
        if set.contains(level) { set.remove(level) } else { set.insert(level) }
        return set.sorted()
    }
}
