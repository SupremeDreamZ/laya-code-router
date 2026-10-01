import AppKit
import SwiftUI

/// What the buttons do. Kept out of the views so each one is a single line, and so the sign-in is
/// started from exactly one place.
enum AccountActions {
    @MainActor
    static func perform(_ action: AccountStatus.Action, terminal: String) {
        switch action {
        case .signIn:
            Launcher.signIn(terminal: terminal)
        case .copyInstall:
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(AccountStatus.installCommand, forType: .string)
        }
    }
}

/// Asks for a sign-in only while there is something to do, and goes away by itself: the daemon
/// notices when Claude Code is signed in and pushes the change, so there is nothing to dismiss and
/// no "I've done it" button. The sign-in itself happens in Claude Code, in the person's terminal.
struct AccountCard: View {
    let account: AccountStatus
    let terminal: String
    @State private var started = false
    @State private var copied = false

    var body: some View {
        if account.needsAttention {
            VStack(alignment: .leading, spacing: Theme.Space.sm) {
                HStack(spacing: Theme.Space.sm) {
                    Circle().fill(Theme.opus).frame(width: 7, height: 7).accessibilityHidden(true)
                    Text(account.headline)
                        .font(Theme.Face.title)
                        .foregroundStyle(Theme.ink)
                }
                Text(started && account.action == .signIn ? account.waitingDetail : account.detail)
                    .font(Theme.Face.micro)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                if let action = account.action {
                    Button {
                        AccountActions.perform(action, terminal: terminal)
                        if action == .signIn { started = true } else { copied = true }
                    } label: {
                        Text(title(for: action))
                            .font(Theme.Face.label)
                            .foregroundStyle(Color(oklch: 0.16, 0.02, 60))
                            .padding(.horizontal, Theme.Space.md)
                            .padding(.vertical, Theme.Space.sm - 1)
                            .background(Theme.accent, in: RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(PressableStyle())
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Space.md)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.opus.opacity(0.4), lineWidth: 1))
            .accessibilityElement(children: .contain)
            // A different state is a different situation: forget that a button was pressed.
            .onChange(of: account.state) { _, _ in
                started = false
                copied = false
            }
        }
    }

    private func title(for action: AccountStatus.Action) -> String {
        switch action {
        case .signIn: started ? account.waitingActionTitle : (account.actionTitle ?? "")
        case .copyInstall: copied ? "Copied" : (account.actionTitle ?? "")
        }
    }
}

/// The same state, as one line in Settings, for the person who goes looking for it there.
struct AccountRow: View {
    let account: AccountStatus
    let terminal: String

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Claude Code")
                    .font(Theme.Face.label)
                    .foregroundStyle(Theme.inkSoft)
                Text(account.summary)
                    .font(Theme.Face.micro)
                    .foregroundStyle(account.needsAttention ? Theme.opus : Theme.faint)
            }
            Spacer(minLength: 0)
            if let action = account.action, let title = account.actionTitle {
                Button(title) { AccountActions.perform(action, terminal: terminal) }
                    .buttonStyle(PressableStyle())
                    .font(Theme.Face.label)
                    .foregroundStyle(Theme.accent)
            }
        }
    }
}
