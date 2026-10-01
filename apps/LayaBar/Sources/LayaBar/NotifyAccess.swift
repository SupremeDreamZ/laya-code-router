import Foundation
import UserNotifications

/// Whether the app may post notifications, reduced to the three situations a person can act on.
/// macOS asks once; if the prompt is dismissed or refused it never asks again, and the only way
/// back is System Settings. So the app has to say so, and offer the door, instead of leaving alerts
/// that silently go nowhere. (Measured on the test Mac: the test alert fired in the daemon and no
/// banner appeared, with nothing in the app to say why.)
enum NotifyAccess: Equatable {
    case unknown, allowed, blocked

    init(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional: self = .allowed
        case .denied: self = .blocked
        default: self = .unknown
        }
    }

    /// What Settings says about it, or nil when everything works and there is nothing to say.
    var message: String? {
        switch self {
        case .allowed:
            return nil
        case .blocked:
            return "macOS is not letting Laya show notifications. Alerts still appear in this panel. Turn them on in System Settings to get banners too."
        case .unknown:
            return "Laya has not been allowed to show notifications yet. Alerts appear in this panel meanwhile."
        }
    }

    var canOpenSettings: Bool { self != .allowed }

    /// The Notifications pane of System Settings, which macOS opens for any app that has asked.
    static let settingsURL = "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
}
