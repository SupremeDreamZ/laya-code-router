import Foundation

/// Whether Claude Code is signed in, as the daemon reports it, and what the panel says about it.
///
/// Sign-in is Claude Code's own. The panel opens `claude auth login` in the person's terminal and
/// never sees a credential; the daemon notices when they finish, and this clears by itself. Every
/// word the person reads about it comes from here, so a view cannot disagree with another.
struct AccountStatus: Decodable, Equatable {
    enum State: String, Equatable {
        case signedIn = "signed-in"
        case signedOut = "signed-out"
        case missing
        /// Not checked yet, or the check gave no clear answer. Never a reason to ask anyone to
        /// sign in: a slow check must not flash a prompt at someone who is already signed in.
        case unknown
    }

    enum Action: Equatable {
        case signIn
        case copyInstall
    }

    var state: State
    /// How they signed in, in the words Claude Code uses ("claude.ai"). Shown only if it is there.
    var method: String?

    static let unknown = AccountStatus(state: .unknown, method: nil)
    /// Claude Code's own commands. The app runs the first one in a terminal and offers the second
    /// to copy; neither takes an argument from anywhere.
    static let loginCommand = "claude auth login"
    static let installCommand = "npm install -g @anthropic-ai/claude-code"

    init(state: State, method: String?) {
        self.state = state
        self.method = method
    }

    // A state or method this version does not understand is "not known", not a failure: one odd
    // field must not take the whole snapshot, and with it the panel, down.
    private enum Keys: String, CodingKey { case state, method }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        state = (try? c.decode(String.self, forKey: .state)).flatMap(State.init(rawValue:)) ?? .unknown
        method = try? c.decode(String.self, forKey: .method)
    }

    var needsAttention: Bool { state == .signedOut || state == .missing }

    var action: Action? {
        switch state {
        case .signedOut: .signIn
        case .missing: .copyInstall
        default: nil
        }
    }

    var headline: String {
        switch state {
        case .signedOut: "Sign in to Claude Code"
        case .missing: "Laya can't find Claude Code"
        case .signedIn: "Signed in to Claude Code"
        case .unknown: "Checking Claude Code"
        }
    }

    var detail: String {
        switch state {
        case .signedOut: "Routing needs your Claude plan. Sign-in opens in your browser and uses your own account."
        case .missing: "Not installed? Run \(Self.installCommand) in a terminal. Installed somewhere unusual? Add LAYA_CLAUDE_BIN=/full/path/to/claude to ~/.laya-router.env."
        case .signedIn: "Routing runs on your Claude plan."
        case .unknown: "Looking for Claude Code."
        }
    }

    var actionTitle: String? {
        switch action {
        case .signIn: "Sign in"
        case .copyInstall: "Copy install command"
        case nil: nil
        }
    }

    /// Shown once the sign-in has been started and until it finishes.
    var waitingDetail: String {
        "Finish in your browser. This clears by itself when you are done."
    }
    var waitingActionTitle: String { "Open again" }

    /// The one line in Settings.
    var summary: String {
        switch state {
        case .signedIn:
            guard let method else { return "Signed in" }
            return "Signed in · \(Self.methodName(method))"
        case .signedOut: return "Not signed in"
        case .missing: return "Claude Code not found"
        case .unknown: return "Not known yet"
        }
    }

    /// Only the method that has been seen on a real sign-in is given a friendlier name; any other
    /// is shown as it came rather than guessed at.
    static func methodName(_ method: String) -> String {
        method == "claude.ai" ? "Claude account" : method
    }
}
