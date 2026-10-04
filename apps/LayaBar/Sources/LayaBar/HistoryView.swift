import SwiftUI

/// The history tab: every decision the router made, newest first, grouped by day. This is where
/// a person checks whether the router is actually being sensible, and can undo a bad call by
/// typing "use opus" in that turn rather than turning the whole thing off.
struct HistoryView: View {
    @ObservedObject var client: ControlClient
    @State private var showPrompts = true

    private var days: [(String, [Snapshot.Event])] {
        let groups = Dictionary(grouping: client.snapshot.events) { day($0.at) }
        return groups.keys.sorted(by: >).map { ($0, groups[$0]!.sorted { $0.at > $1.at }) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.md) {
                if client.snapshot.events.isEmpty {
                    EmptyState(
                        icon: "clock.arrow.circlepath",
                        title: "No decisions yet",
                        message: "Start a session and every model choice Laya makes will be listed here, newest first."
                    )
                }
                ForEach(days, id: \.0) { day, events in
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        SectionLabel(relative(day), trailing: "\(events.count)")
                        ForEach(events) { e in
                            EventRow(e: e, showPrompt: showPrompts)
                        }
                    }
                }
            }
            .padding(.horizontal, Theme.Space.panel)
            .padding(.top, Theme.Space.sm)
            .padding(.bottom, Theme.Space.lg)
        }
        .scrollIndicators(.never)
    }

    private func day(_ at: Double) -> String {
        let d = Date(timeIntervalSince1970: at / 1000)
        return Calendar.current.startOfDay(for: d).timeIntervalSince1970.description
    }

    private func relative(_ key: String) -> String {
        guard let ts = Double(key) else { return key }
        let d = Date(timeIntervalSince1970: ts)
        return Calendar.current.isDateInToday(d) ? "Today" : d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }
}

struct EventRow: View {
    let e: Snapshot.Event
    let showPrompt: Bool
    @State private var open = false

    var body: some View {
        Button {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) { open.toggle() }
        } label: {
            HStack(alignment: .top, spacing: Theme.Space.sm) {
                Image(systemName: e.kind == "guard" ? "shield.lefthalf.filled" : Theme.glyph(e.tier ?? ""))
                    .font(.system(size: 11))
                    .foregroundStyle(e.kind == "guard" ? Theme.inkSoft : Theme.tier(e.tier))
                    .frame(width: 14)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Theme.Space.sm) {
                        Text(e.kind == "guard" ? (e.reason ?? "Guard") : Theme.label(e.tier ?? "?"))
                            .font(Theme.Face.micro)
                            .foregroundStyle(e.kind == "guard" ? Theme.inkSoft : Theme.tier(e.tier))
                            .lineLimit(1)
                        if let effort = e.effort {
                            Text("effort \(effort)")
                                .font(Theme.Face.micro)
                                .foregroundStyle(Theme.faint)
                        }
                        if let c = e.cleared {
                            Text("trimmed \(Self.tokens(c.tokens))")
                                .font(Theme.Face.micro)
                                .foregroundStyle(Theme.faint)
                                .help("\(Int(c.toolUses)) old tool results cleared from this request's prompt")
                        }
                        Spacer(minLength: 0)
                        Text(clock(e.at))
                            .font(Theme.Face.micro)
                            .foregroundStyle(Theme.faint)
                    }
                    if showPrompt, let p = e.prompt, !p.isEmpty {
                        Text(p)
                            .font(Theme.Face.micro)
                            .foregroundStyle(Theme.muted)
                            .lineLimit(open ? 12 : 1)
                            .multilineTextAlignment(.leading)
                    }
                }
            }
            .padding(.horizontal, Theme.Space.md)
            .padding(.vertical, Theme.Space.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(PressableStyle())
    }

    static func tokens(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        return n >= 1000 ? "\(Int((n / 1000).rounded()))k" : "\(Int(n))"
    }

    private func clock(_ at: Double) -> String {
        Date(timeIntervalSince1970: at / 1000).formatted(.dateTime.hour().minute())
    }
}

struct EmptyState: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: Theme.Space.sm) {
            Image(systemName: icon)
                .font(.system(size: 22))
                .foregroundStyle(Theme.faint)
            Text(title)
                .font(Theme.Face.title)
                .foregroundStyle(Theme.inkSoft)
            Text(message)
                .font(Theme.Face.micro)
                .foregroundStyle(Theme.faint)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Space.xl)
    }
}
