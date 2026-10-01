import AppKit
import UserNotifications

/// Puts the daemon's alerts on the screen as real macOS notifications. The daemon decides *when*
/// something is worth saying (thresholds, limit hit, reset); this only delivers it once.
///
/// Permission is the user's to give. macOS asks the first time, and if it is refused the alerts
/// still appear in the panel, which does not depend on it.
/// The notification state, as something a view can observe.
@MainActor
final class NotifyStatus: ObservableObject {
    @Published var access: NotifyAccess = .allowed
}

@MainActor
final class Notifier: NSObject {
    let status = NotifyStatus()
    /// Published so Settings can show the real state instead of leaving alerts that go nowhere.
    private(set) var access: NotifyAccess = .unknown {
        didSet { if access != oldValue { status.access = access } }
    }
    private var feed = AlertFeed()
    /// nil when not running from a real .app (a bare executable cannot use notifications).
    private let center: UNUserNotificationCenter?

    override init() {
        center = Bundle.main.bundleIdentifier != nil ? UNUserNotificationCenter.current() : nil
        super.init()
    }

    func start() {
        guard let center else { return }
        center.delegate = self
        Task { await refreshAccess(asking: true) }
    }

    /// Reads what macOS says now. With `asking`, an undecided state triggers the system prompt once;
    /// it is never re-raised, because macOS will not show it twice and a prompt that does nothing
    /// is worse than none.
    func refreshAccess(asking: Bool = false) async {
        guard let center else { return }
        var status = await center.notificationSettings().authorizationStatus
        if asking, status == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            status = await center.notificationSettings().authorizationStatus
        }
        access = NotifyAccess(status)
    }

    /// Called with every snapshot. Only alerts not seen before are delivered, and nothing is
    /// delivered (or remembered) until the snapshot is a real one from a connected daemon.
    func observe(_ alerts: [Snapshot.Alert], live: Bool) {
        for alert in feed.fresh(alerts, live: live) { deliver(alert) }
    }

    private func deliver(_ alert: Snapshot.Alert) {
        guard let center, access != .blocked else { return }
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.threadIdentifier = "laya.usage.\(alert.window ?? "account")"
        // A limit you have hit deserves a sound; a heads-up at 75% does not.
        if alert.level == "critical" { content.sound = .default }
        let request = UNNotificationRequest(identifier: alert.id, content: content, trigger: nil)
        center.add(request) { _ in }
    }
}

extension Notifier: @preconcurrency UNUserNotificationCenterDelegate {
    /// An accessory app counts as "in front" while its panel is open, and macOS would swallow the
    /// banner. Showing it anyway is the point of an alert.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
