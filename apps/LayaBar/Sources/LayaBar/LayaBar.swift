import SwiftUI
import AppKit
import Network
import Combine

/// The menu-bar app. One window, one job: let a person see what the router is doing to their
/// work and change any of it without opening a terminal.
///
/// Structure: an `NSStatusItem` in the menu bar (the little icon) that opens a `NSPanel` with a
/// SwiftUI hierarchy inside. A panel rather than a window because it should feel attached to the
/// icon, close on outside click, and never steal focus from the editor behind it.
@main
enum LayaBar {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem?
    private var panel: NSPanel?
    private let client = ControlClient()
    private let notifier = Notifier()
    private var subscriptions = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The router is a separate background job. If it is not running (the app was opened on its
        // own, or after "Quit Laya"), ask launchd to start it; if it is, this does nothing.
        DaemonControl.ensureRunning()
        client.connect()
        buildItem()
        // Nothing here should be in the Dock or the app switcher: this is a menu-bar tool.
        NSApp.setActivationPolicy(.accessory)

        notifier.start()
        // Every snapshot the daemon pushes: deliver alerts not shown before, and keep the figure
        // beside the icon current. `live` gates both, so the empty placeholder the app starts with
        // is never mistaken for real data.
        client.$snapshot
            .combineLatest(client.$live)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] snapshot, live in
                self?.notifier.observe(snapshot.alertList, live: live)
                self?.refreshMenuBar(snapshot, live: live)
            }
            .store(in: &subscriptions)

        // The figure is judged against the clock, and a snapshot is pushed only when something
        // changes. A quiet daemon (offline, or between its five-minute checks) sends nothing, so a bar
        // left alone would go on showing a window that has ended, or a reading that has gone stale,
        // exactly as it was drawn.
        Timer.publish(every: 30, on: .main, in: .common).autoconnect()
            .sink { [weak self] _ in
                guard let self else { return }
                self.refreshMenuBar(self.client.snapshot.advanced(to: Date().timeIntervalSince1970 * 1000), live: self.client.live)
            }
            .store(in: &subscriptions)
    }

    /// The figure beside the icon. What it says, and when it says nothing, is decided by
    /// `MenuBarFigure`, and how it is drawn is `apply(to:)`; this only connects the two.
    private func refreshMenuBar(_ snapshot: Snapshot, live: Bool) {
        guard let button = item?.button else { return }
        MenuBarFigure.make(snapshot, live: live).apply(to: button)
    }

    private func buildItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Laya router")
        item.button?.imagePosition = .imageLeading
        item.button?.target = self
        item.button?.action = #selector(togglePanel)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        self.item = item
    }

    /// A borderless popover has no close button, so clicking away is the way out. Watching the
    /// global mouse events is the only way to know about clicks that land in another app.
    private var outsideMonitor: Any?

    private func watchOutsideClicks(_ panel: NSPanel) {
        guard outsideMonitor == nil else { return }
        outsideMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self, weak panel] _ in
            guard let self, let panel, panel.isVisible else { return }
            let at = NSEvent.mouseLocation
            if !panel.frame.contains(at) { self.togglePanel() }
        }
    }

    @objc private func togglePanel() {
        if let panel, panel.isVisible {
            panel.orderOut(nil)
            NSApp.setActivationPolicy(.accessory)
            return
        }
        let panel = self.panel ?? makePanel()
        self.panel = panel
        position(panel)
        watchOutsideClicks(panel)
        panel.orderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKey()
    }

    /// Puts the panel under its own status item, the way a menu-bar popover is expected to
    /// appear. Without this it opens wherever AppKit decides (bottom-left), which reads as a
    /// broken window rather than something attached to the icon you just clicked.
    private func position(_ panel: NSPanel) {
        guard let button = item?.button, let window = button.window else { return }
        let screen = window.screen ?? NSScreen.main
        guard let screen else { return }
        let size = panel.frame.size
        let visible = screen.visibleFrame
        // The status item's right edge, in screen coordinates. Converting the button's own
        // bounds is reliable; converting through the window's coordinate space is not, because
        // the status bar's window has an unusual origin.
        let buttonFrame = button.convert(button.bounds, to: nil)
        let inWindow = window.convertToScreen(buttonFrame)
        var x = inWindow.maxX - size.width
        x = min(x, visible.maxX - size.width - 8)
        x = max(x, visible.minX + 8)
        // A few points of overlap reads as connected; a gap reads as unrelated.
        let y = visible.maxY - size.height - 4
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func makePanel() -> NSPanel {
        let panel = PanelShell.make()
        panel.contentView = NSHostingView(rootView: RootView(client: client, notify: notifier.status, recheck: { [weak self] in
            Task { await self?.notifier.refreshAccess() }
        }))
        return panel
    }
}

/// The window around the panel's content: borderless, floating at the status-bar level, dark whatever the Mac is set to.
enum PanelShell {
    static func make() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 520),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isReleasedWhenClosed = false
        panel.appearance = PanelAppearance.forced
        return panel
    }
}

/// The panel's palette is dark-only (see `Theme`), so the system controls inside it must be dark too.
/// Left to follow the Mac, a light-mode Mac drew the header icons and the eagerness picker in dark
/// ink on the dark panel, so they could not be seen (found 2026-10-01 by capturing the panel in light mode).
enum PanelAppearance {
    static var forced: NSAppearance? { NSAppearance(named: .darkAqua) }
}

/// The panel. Sections, top to bottom, in the order a person asks for them:
/// am I on → what did it do → what did that save me → what can I change.
struct RootView: View {
    @ObservedObject var client: ControlClient
    @ObservedObject var notify: NotifyStatus
    var recheck: () -> Void = {}
    @State private var tab: Tab = .home
    @State private var confirmingQuit = false

    enum Tab: String, CaseIterable, Identifiable {
        case home = "Home"
        case history = "History"
        case settings = "Settings"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            switch tab {
            case .home: HomeView(client: client)
            case .history: HistoryView(client: client)
            case .settings: SettingsView(client: client, access: notify.access, recheck: recheck)
            }
            footer
        }
        .frame(width: 340, height: 520)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Theme.paper)
                // A hairline edge so the panel separates from whatever is behind it, plus a
                // drop shadow: without both it reads as a hole rather than a surface.
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Theme.rule.opacity(0.8), lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .shadow(color: .black.opacity(0.45), radius: 18, y: 8)
        .foregroundStyle(Theme.ink)
        .tint(Theme.accent)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Space.md) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.sm) {
                Text("Laya")
                    .font(.system(size: 17, weight: .semibold))
                    .tracking(-0.01)
                StatusDot(
                    dot: client.snapshot.router.dot(routingOn: client.snapshot.prefs.enabled),
                    help: client.snapshot.router.help(routingOn: client.snapshot.prefs.enabled)
                )
                Spacer(minLength: 0)
                Picker("", selection: $tab) {
                    ForEach(Tab.allCases) { t in
                        Image(systemName: icon(t)).tag(t).help(t.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 96)
            }
        }
        .padding(.horizontal, Theme.Space.panel)
        .padding(.top, Theme.Space.md)
        .padding(.bottom, Theme.Space.sm)
    }

    /// One tap when nothing is running. If a session used the router in the last five minutes the
    /// first tap asks, and a second confirms: quitting would drop that session's routing.
    private func requestQuit() {
        let busy = Usage.recentlyActive(
            lastEventAt: client.snapshot.events.last?.at,
            nowMs: Date().timeIntervalSince1970 * 1000
        )
        if busy && !confirmingQuit {
            confirmingQuit = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { confirmingQuit = false }
            return
        }
        client.quitDaemon(thenQuit: true)
    }

    private func icon(_ t: Tab) -> String {
        switch t {
        case .home: "house.fill"
        case .history: "clock.arrow.circlepath"
        case .settings: "slider.horizontal.3"
        }
    }

    private var footer: some View {
        HStack(spacing: Theme.Space.sm) {
            if let err = client.lastError {
                Text(err)
                    .font(Theme.Face.micro)
                    .foregroundStyle(Theme.faint)
                    .lineLimit(1)
            } else if !client.connected {
                Text("Not connected")
                    .font(Theme.Face.micro)
                    .foregroundStyle(Theme.faint)
            } else {
                Text("Laya \(client.snapshot.prefs.preset) · \(client.snapshot.tiers.count) models")
                    .font(Theme.Face.micro)
                    .foregroundStyle(Theme.faint)
            }
            Spacer(minLength: 0)
            Button(confirmingQuit ? "Quit anyway?" : "Quit Laya") { requestQuit() }
                .buttonStyle(.plain)
                .font(Theme.Face.micro)
                .foregroundStyle(confirmingQuit ? Theme.opus : Theme.faint)
                .help("Stops the router and closes this app. Sessions already open keep working but are not routed.")
        }
        .padding(.horizontal, Theme.Space.panel)
        .padding(.vertical, Theme.Space.sm)
        .overlay(alignment: .top) { Rule() }
    }
}

/// The status dot: warm and lit when the router is on, hollow when paused, red when the local
/// model failed to load. Shape carries the state too, so it is not colour-only.
private struct StatusDot: View {
    let dot: RouterStatus.Dot
    let help: String

    var body: some View {
        Circle()
            .fill(fill)
            .frame(width: 7, height: 7)
            // A hollow ring for "off" and a ring around anything that needs the person, so the
            // state is readable without colour: lit = ready, hollow = off, ringed = needs you,
            // dim = not yet.
            .overlay(Circle().strokeBorder(ring, lineWidth: dot == .off ? 1 : (dot.isLoud ? 1.5 : 0)))
            .scaleEffect(dot.isLoud ? 1.25 : 1)
            .help(help)
            .accessibilityLabel(help)
    }

    private var fill: Color {
        switch dot {
        case .ready: Theme.accent
        case .loading: Theme.sonnet.opacity(0.75)
        case .failed, .attention: Theme.opus
        case .idle: Theme.muted
        case .off: .clear
        }
    }

    private var ring: Color { dot.isLoud ? Theme.opus.opacity(0.45) : Theme.rule }
}

struct Rule: View {
    var body: some View {
        Rectangle().fill(Theme.rule).frame(height: 1).opacity(0.7)
    }
}
