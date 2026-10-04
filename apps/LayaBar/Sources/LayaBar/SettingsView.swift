import SwiftUI

/// The settings tab. Every knob the router has, in plain words, grouped by what it affects.
/// Nothing here is a raw number except the ones that really are numbers (thresholds), and those
/// say what they mean next to them.
struct SettingsView: View {
    @ObservedObject var client: ControlClient
    var access: NotifyAccess = .allowed
    var recheck: () -> Void = {}
    @State private var showAdvanced = false

    private var prefs: Snapshot.Prefs { client.snapshot.prefs }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.lg) {
                Group {
                    SectionLabel("How eagerly it saves")
                    Picker("", selection: Binding(get: { prefs.preset }, set: { client.update(.init(preset: $0)) })) {
                        ForEach(["savings", "balanced", "careful"], id: \.self) { p in
                            Text(presetLabel(p)).tag(p)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    Text(presetBlurb(prefs.preset))
                        .font(Theme.Face.micro)
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Group {
                    SectionLabel("Models it may use")
                    VStack(spacing: Theme.Space.xs) {
                        ForEach(client.snapshot.models.map(\.tier), id: \.self) { tier in
                            TierRow(
                                tier: tier,
                                on: prefs.tier(tier),
                                blurb: Theme.blurb(tier),
                                price: priceLine(tier)
                            ) { client.update(prefs.toggling(tier)) }
                        }
                    }
                    Text("Turning a model off means it is never chosen. Work that needs it is sent to the next model up instead.")
                        .font(Theme.Face.micro)
                        .foregroundStyle(Theme.faint)
                        .fixedSize(horizontal: false, vertical: true)
                }

                AlertSettings(client: client, access: access, recheck: recheck)

                Group {
                    SectionLabel("Thinking")
                    ToggleRow(
                        icon: "brain.head.profile",
                        title: "Let Laya pick effort",
                        subtitle: "Chooses how hard each model thinks. Off means every model runs at its own default."
                    , set: { client.update(.init(effortAuto: $0)) }, isOn: prefs.effortAuto)

                    ToggleRow(
                        icon: "person.2",
                        title: "Route sub-agents too",
                        subtitle: "Laya scores each sub-agent's task and picks its model and effort, even when the main agent named a model for it. Words in the task such as \"use opus\" still win. Off means a named model is kept."
                    , set: { client.update(.init(routeSubagents: $0)) }, isOn: prefs.routeSubagentsOn)

                    ToggleRow(
                        icon: "scissors",
                        title: "Trim old tool results",
                        subtitle: "In long tool loops past about 120k tokens, old file contents and command output are cleared from the prompt in large steps, keeping the latest 8 whole. The model can re-read anything it needs."
                    , set: { client.update(.init(trimToolResults: $0)) }, isOn: prefs.trimOn)

                    ToggleRow(
                        icon: "shield.lefthalf.filled",
                        title: "Guard risky commands",
                        subtitle: "Before a shell command or a write to a secrets file, rules and one Laya question check it. Clear damage is blocked; anything Laya thinks is destructive asks you first, or is blocked in a headless run. Applies to sessions started after you turn it on."
                    , set: { client.update(.init(guard_: $0)) }, isOn: prefs.guardOn)

                    ToggleRow(
                        icon: "doc.text.magnifyingglass",
                        title: "File ranking tool",
                        subtitle: "Gives sessions a tool that ranks files by a question about their content without reading them in. A ranking, not proof, about 1.5 s a file. Applies to sessions started after you turn it on."
                    , set: { client.update(.init(rankFiles: $0)) }, isOn: prefs.rankFilesOn)

                    ToggleRow(
                        icon: "text.quote",
                        title: "Show prompt text",
                        subtitle: "Keeps what you typed in the History list. It never leaves this Mac either way."
                    , set: { client.update(.init(showPrompts: $0)) }, isOn: prefs.showPrompts)
                }

                Group {
                    SectionLabel("When routing is off")
                    HStack(spacing: Theme.Space.sm) {
                        ForEach(["haiku", "sonnet", "opus"], id: \.self) { name in
                            ChoiceChip(
                                label: Theme.label(name),
                                selected: prefs.pausedTier == name,
                                tint: Theme.tier(name)
                            ) { client.update(.init(pausedTier: name)) }
                        }
                    }
                }

                Group {
                    SectionLabel("What savings are measured against")
                    Picker("", selection: Binding(get: { prefs.baselineTier }, set: { client.update(.init(baselineTier: $0)) })) {
                        ForEach(["sonnet", "opus", "fable"], id: \.self) { t in
                            Text(Theme.label(t)).tag(t)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    Text("Your plan does not bill per token, so the figure is what these turns would have cost at Anthropic's list prices.")
                        .font(Theme.Face.micro)
                        .foregroundStyle(Theme.faint)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Group {
                    SectionLabel("Starting a session")
                    Picker("", selection: Binding(get: { prefs.launch.engine }, set: { setEngine($0) })) {
                        Text("Claude Code").tag("claude")
                        Text("Codex").tag("codex")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    Picker("", selection: Binding(get: { prefs.launch.terminal }, set: { client.update(.init(launch: .init(terminal: $0))) })) {
                        ForEach(Terminals.common, id: \.self) { t in
                            Text(Terminals.label(t)).tag(t)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    ToggleRow(icon: "arrow.clockwise", title: "Resume the last session", subtitle: "",
                              set: { client.update(.init(launch: .init(resume: $0))) },
                              isOn: prefs.launch.resume)
                }

                Group {
                    DisclosureGroup(isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: Theme.Space.xs) {
                            ThresholdRow("Cheap model cut", client.snapshot.tiers.contains("haiku") ? "0.48" : "—",
                                         "Below this, a turn can go to Haiku.")
                            ThresholdRow("Cheap model veto", "0.45",
                                         "Above this, never Haiku: the work needs investigating or design.")
                            ThresholdRow("Strong model floor", "0.52",
                                         "At or above this, the turn goes to Opus.")
                            Button("Reset savings totals") { client.resetUsage() }
                                .buttonStyle(PressableStyle())
                                .font(Theme.Face.label)
                                .foregroundStyle(Theme.muted)
                                .padding(.top, Theme.Space.xs)
                        }
                        .padding(.top, Theme.Space.sm)
                    } label: {
                        Text("Thresholds")
                            .font(Theme.Face.label)
                            .foregroundStyle(Theme.inkSoft)
                    }
                    Text("These are the calibrated defaults. They were fitted on 116 labelled prompts and have not been re-fitted since.")
                        .font(Theme.Face.micro)
                        .foregroundStyle(Theme.faint)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Group {
                    SectionLabel("Claude Code")
                    AccountRow(account: client.snapshot.accountStatus, terminal: prefs.launch.terminal)
                }

                Group {
                    SectionLabel("Router")
                    let router = client.snapshot.router
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(router.headline)
                                .font(Theme.Face.label)
                                .foregroundStyle(router.dot == .failed ? Theme.opus : Theme.inkSoft)
                            Text(router.detail)
                                .font(Theme.Face.micro)
                                .foregroundStyle(Theme.faint)
                                .fixedSize(horizontal: false, vertical: true)
                            if let problem = router.problem {
                                Text(problem)
                                    .font(Theme.Face.micro)
                                    .foregroundStyle(Theme.inkSoft)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.top, 2)
                            }
                        }
                        Spacer(minLength: 0)
                        Button(router.buttonTitle) {
                            let e = prefs.launch.engine
                            router.buttonStops ? client.stopEngine(e) : client.startEngine(e)
                        }
                        .buttonStyle(PressableStyle())
                        .font(Theme.Face.label)
                        .foregroundStyle(Theme.accent)
                    }
                }
            }
            .padding(.horizontal, Theme.Space.panel)
            .padding(.top, Theme.Space.sm)
            .padding(.bottom, Theme.Space.lg)
        }
        .scrollIndicators(.never)
    }

    private func presetLabel(_ p: String) -> String {
        switch p {
        case "savings": "Save most"
        case "careful": "Careful"
        default: "Balanced"
        }
    }

    private func presetBlurb(_ p: String) -> String {
        switch p {
        case "savings": "Tries the cheap model first, even for work that will need a second try."
        case "careful": "Sends more work to the strong model, and less to the cheap one."
        default: "Ordinary coding on Sonnet, hard work on Opus, lookups on Haiku."
        }
    }

    private func priceLine(_ tier: String) -> String {
        switch tier {
        case "haiku": "$1 in · $5 out per million tokens"
        case "sonnet": "$2 in · $10 out"
        case "opus": "$4 in · $20 out"
        case "fable": "$10 in · $50 out · extra credits"
        default: ""
        }
    }

    private func setEngine(_ engine: String) {
        var launch = Snapshot.PrefsPatch.LaunchPatch()
        launch.engine = engine
        client.update(.init(launch: launch))
        // Switching engines should also start that one, or the button below is a lie.
        client.startEngine(engine)
    }
}

struct TierRow: View {
    let tier: String
    let on: Bool
    let blurb: String
    let price: String
    let set: () -> Void

    var body: some View {
        Button(action: set) {
            HStack(alignment: .top, spacing: Theme.Space.md) {
                Image(systemName: Theme.glyph(tier))
                    .font(.system(size: 13))
                    .foregroundStyle(on ? Theme.tier(tier) : Theme.faint)
                    .frame(width: 18)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Theme.label(tier))
                        .font(Theme.Face.label)
                        .foregroundStyle(on ? Theme.ink : Theme.faint)
                    Text(blurb)
                        .font(Theme.Face.micro)
                        .foregroundStyle(Theme.faint)
                    Text(price)
                        .font(Theme.Face.micro)
                        .foregroundStyle(Theme.faint.opacity(0.8))
                }
                Spacer(minLength: 0)
                Toggle("", isOn: Binding(get: { on }, set: { _ in set() }))
                    .labelsHidden()
                    .toggleStyle(SwitchKnob())
                    .scaleEffect(0.85)
            }
            .padding(.horizontal, Theme.Space.md)
            .padding(.vertical, Theme.Space.sm + 2)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(PressableStyle())
    }
}

struct ToggleRow: View {
    let icon: String
    let title: String
    let subtitle: String
    let set: (Bool) -> Void
    let isOn: Bool

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.md) {
            Image(systemName: icon)
                .font(.system(size: 13))
                .foregroundStyle(isOn ? Theme.accent : Theme.faint)
                .frame(width: 18)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Theme.Face.label).foregroundStyle(Theme.ink)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(Theme.Face.micro)
                        .foregroundStyle(Theme.faint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Theme.Space.sm)
            Toggle("", isOn: Binding(get: { isOn }, set: set))
                .labelsHidden()
                .toggleStyle(SwitchKnob())
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm + 2)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 9))
    }
}

struct ThresholdRow: View {
    let name: String
    let value: String
    let note: String

    init(_ name: String, _ value: String, _ note: String) {
        self.name = name
        self.value = value
        self.note = note
    }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.sm) {
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(Theme.Face.micro).foregroundStyle(Theme.inkSoft)
                Text(note).font(Theme.Face.micro).foregroundStyle(Theme.faint).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Theme.Space.sm)
            Text(value)
                .font(Theme.Face.figure)
                .foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
    }
}
