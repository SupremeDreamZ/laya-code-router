import XCTest
@testable import LayaBar

/// What the panel says about Claude Code's sign-in, and how it opens one.
///
/// Sign-in is Claude Code's own. The app opens `claude auth login` in the person's terminal, where
/// the browser hand-off is visible, and never sees a credential. The panel reads the state the
/// daemon reports, and it clears by itself when they finish.
final class AccountTests: XCTestCase {
    private func status(_ state: AccountStatus.State, _ method: String? = nil) -> AccountStatus {
        AccountStatus(state: state, method: method)
    }

    // MARK: - what each state asks of the person

    func testSignedOutAsksForASignIn() {
        let a = status(.signedOut)
        XCTAssertTrue(a.needsAttention)
        XCTAssertEqual(a.headline, "Sign in to Claude Code")
        XCTAssertEqual(a.action, .signIn)
        XCTAssertEqual(a.actionTitle, "Sign in")
    }

    func testMissingDoesNotClaimItIsNotInstalledBecauseItOnlyKnowsItCouldNotFindIt() {
        // Someone whose Claude Code lives somewhere unusual would otherwise be told, wrongly and
        // for as long as the panel is open, that they have not installed what they use every day.
        let a = status(.missing)
        XCTAssertTrue(a.needsAttention)
        XCTAssertEqual(a.headline, "Laya can't find Claude Code")
        XCTAssertFalse(a.headline.lowercased().contains("not installed"))
        XCTAssertEqual(a.action, .copyInstall)
        XCTAssertEqual(AccountStatus.installCommand, "npm install -g @anthropic-ai/claude-code")
    }

    func testMissingOffersBothWaysOut() {
        let a = status(.missing)
        XCTAssertTrue(a.detail.contains(AccountStatus.installCommand), "not installed: how to install it")
        XCTAssertTrue(a.detail.contains("LAYA_CLAUDE_BIN"), "installed somewhere unusual: how to say where")
        XCTAssertTrue(a.detail.contains("~/.laya-router.env"), "and the file to say it in")
    }

    func testSignedInAsksForNothing() {
        let a = status(.signedIn, "claude.ai")
        XCTAssertFalse(a.needsAttention)
        XCTAssertNil(a.action)
        XCTAssertNil(a.actionTitle)
    }

    func testNotKnowingYetNeverFlashesAPromptAtSomeoneWhoIsSignedIn() {
        let a = status(.unknown)
        XCTAssertFalse(a.needsAttention)
        XCTAssertNil(a.action)
    }

    func testTheSignInCommandIsClaudeCodesOwnAndTakesNoArguments() {
        XCTAssertEqual(AccountStatus.loginCommand, "claude auth login")
    }

    func testNoWordingAsksForAKeyACodeOrAPassword() {
        let states: [AccountStatus.State] = [.signedIn, .signedOut, .missing, .unknown]
        for state in states {
            let a = status(state, "claude.ai")
            let text = [a.headline, a.detail, a.actionTitle ?? "", a.waitingDetail, a.summary].joined(separator: " ").lowercased()
            for word in ["paste", "api key", "password", "token", "sk-"] {
                XCTAssertFalse(text.contains(word), "\(state): mentions \(word)")
            }
        }
    }

    // MARK: - the header dot must not say "ready" to someone who cannot use it

    private func router(_ state: String, account: AccountStatus = .unknown, proxy: Bool = true) -> RouterStatus {
        RouterStatus(sidecar: .init(state: state, since: nil, lastError: nil), proxyRunning: proxy, account: account)
    }

    func testNeedingToSignInShowsAsAttentionWhateverTheModelIsDoing() {
        for account in [status(.signedOut), status(.missing)] {
            for state in ["stopped", "starting", "warm", "error"] {
                XCTAssertEqual(router(state, account: account).dot, .attention, "\(state) / \(account.state)")
            }
        }
    }

    func testSignedInOrNotKnownLeavesTheDotAsItWas() {
        for account in [status(.signedIn, "claude.ai"), status(.unknown)] {
            for state in ["stopped", "starting", "warm", "error"] {
                XCTAssertEqual(router(state, account: account).dot, router(state).dot, "\(state) / \(account.state)")
            }
        }
    }

    func testNothingIsRoutingSoItIsOffWhateverTheAccountSays() {
        XCTAssertEqual(router("warm", account: status(.signedOut), proxy: false).dot, .off)
        XCTAssertEqual(router("warm", account: status(.signedOut)).dot(routingOn: false), .off, "paused by the person")
        XCTAssertEqual(router("warm", account: status(.signedOut)).dot(routingOn: true), .attention)
    }

    func testTheAttentionDotSaysWhyInWordsNotJustColour() {
        XCTAssertEqual(router("warm", account: status(.signedOut)).help(routingOn: true), "Sign in to Claude Code")
        XCTAssertEqual(router("warm", account: status(.missing)).help(routingOn: true), "Laya can't find Claude Code")
        XCTAssertEqual(router("warm", account: status(.signedIn)).help(routingOn: true), "Routing is ready")
        XCTAssertEqual(router("warm", account: status(.signedOut)).help(routingOn: false), "Routing is off")
        let labels = [RouterStatus.Dot.ready, .loading, .failed, .idle, .off, .attention].map(\.accessibilityLabel)
        XCTAssertEqual(Set(labels).count, labels.count, "two dots share a label, so VoiceOver cannot tell them apart")
        XCTAssertTrue(labels.allSatisfy { !$0.isEmpty })
    }

    func testAttentionIsDrawnAsLoudlyAsAFailureAndNothingElseIs() {
        XCTAssertTrue(RouterStatus.Dot.attention.isLoud)
        XCTAssertTrue(RouterStatus.Dot.failed.isLoud)
        for quiet in [RouterStatus.Dot.ready, .loading, .idle, .off] { XCTAssertFalse(quiet.isLoud, "\(quiet)") }
    }

    func testTheRouterCardStaysAboutTheRouter() {
        // Signed out does not make the routing model any less ready; the Claude Code row says the
        // rest. Two true statements side by side, not one muddled one.
        let r = router("warm", account: status(.signedOut))
        XCTAssertEqual(r.headline, "Ready")
        XCTAssertNil(r.problem)
    }

    // MARK: - after the button is pressed

    func testAfterPressingSignInItSaysWhatHappensNext() {
        let a = status(.signedOut)
        XCTAssertTrue(a.waitingDetail.contains("browser"))
        XCTAssertTrue(a.waitingDetail.contains("by itself"), "the person should know nothing else needs clicking")
        XCTAssertEqual(a.waitingActionTitle, "Open again")
    }

    // MARK: - the one-line summary for Settings

    func testTheSummaryNamesTheMethodOnlyWhenItKnowsIt() {
        XCTAssertEqual(status(.signedIn, "claude.ai").summary, "Signed in · Claude account")
        XCTAssertEqual(status(.signedIn).summary, "Signed in")
        XCTAssertEqual(status(.signedIn, "some_new_method").summary, "Signed in · some_new_method", "an unfamiliar method is shown as it came, not guessed at")
        XCTAssertEqual(status(.signedOut).summary, "Not signed in")
        XCTAssertEqual(status(.missing).summary, "Claude Code not found")
        XCTAssertEqual(status(.unknown).summary, "Not known yet")
    }

    // MARK: - decoding what the daemon sends

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"), "missing fixture \(name)")
        return try Data(contentsOf: url)
    }

    func testTheRealSnapshotCarriesTheAccount() throws {
        let s = try JSONDecoder().decode(Snapshot.self, from: fixture("snapshot-full"))
        XCTAssertEqual(s.accountStatus, AccountStatus(state: .signedIn, method: "claude.ai"))
    }

    func testAnOlderDaemonSendsNoAccountAndThatIsNotTheSameAsSignedOut() throws {
        let s = try JSONDecoder().decode(Snapshot.self, from: fixture("snapshot-legacy"))
        XCTAssertEqual(s.accountStatus.state, .unknown)
        XCTAssertFalse(s.accountStatus.needsAttention)
    }

    func testTheRealSnapshotCarriesNothingPersonalAboutTheAccount() throws {
        let text = try XCTUnwrap(String(data: fixture("snapshot-full"), encoding: .utf8))
        for word in ["someone@", "org-0000", "Invented Studio", "\"email\"", "orgName", "subscriptionType"] {
            XCTAssertFalse(text.contains(word), "the fixture contains \(word)")
        }
    }

    private func decodeAccount(_ json: String) throws -> AccountStatus {
        try JSONDecoder().decode(AccountStatus.self, from: Data(json.utf8))
    }

    func testEachStateTheDaemonNamesIsUnderstood() throws {
        XCTAssertEqual(try decodeAccount(#"{"state":"signed-in","method":"claude.ai"}"#), status(.signedIn, "claude.ai"))
        XCTAssertEqual(try decodeAccount(#"{"state":"signed-out","method":null}"#), status(.signedOut))
        XCTAssertEqual(try decodeAccount(#"{"state":"missing","method":null}"#), status(.missing))
        XCTAssertEqual(try decodeAccount(#"{"state":"unknown","method":null}"#), status(.unknown))
    }

    func testAStateThisVersionDoesNotKnowIsNotKnownRatherThanAFailure() throws {
        XCTAssertEqual(try decodeAccount(#"{"state":"expired","method":null}"#), status(.unknown))
        XCTAssertEqual(try decodeAccount(#"{"method":"claude.ai"}"#).state, .unknown, "no state at all")
        XCTAssertEqual(try decodeAccount(#"{}"#), status(.unknown))
    }

    func testExtraFieldsAreIgnored() throws {
        XCTAssertEqual(try decodeAccount(#"{"state":"signed-in","method":"claude.ai","email":"x@y.z","plan":"max"}"#), status(.signedIn, "claude.ai"))
    }

    func testAMethodThatIsNotAStringIsDropped() throws {
        XCTAssertNil(try decodeAccount(#"{"state":"signed-in","method":{"a":1}}"#).method)
        XCTAssertNil(try decodeAccount(#"{"state":"signed-in","method":7}"#).method)
    }

    func testAMalformedAccountDoesNotTakeTheWholeSnapshotDown() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("snapshot-full")) as? [String: Any])
        object["account"] = ["state": ["not", "a", "string"], "method": 3]
        let data = try JSONSerialization.data(withJSONObject: object)
        let s = try JSONDecoder().decode(Snapshot.self, from: data)
        XCTAssertEqual(s.accountStatus.state, .unknown)
        XCTAssertFalse(s.usage.today.cost.isNaN, "and the rest of the snapshot is intact")
    }

    // MARK: - opening the sign-in

    func testTheCommandLineChangesFolderFirstWhenOneIsGiven() {
        XCTAssertEqual(Launcher.commandLine("laya-claude", dir: "/Users/me/my project"), "cd '/Users/me/my project' && laya-claude")
        XCTAssertEqual(Launcher.commandLine("laya-claude", dir: "/it's"), "cd '/it'\\''s' && laya-claude")
        XCTAssertEqual(Launcher.commandLine("laya-claude", dir: nil), "laya-claude")
        XCTAssertEqual(Launcher.commandLine("laya-claude", dir: ""), "laya-claude")
    }

    func testSigningInNeverDependsOnALaunchFolder() {
        // A launch folder that has since been deleted would make `cd` fail, and the sign-in
        // would silently never start.
        XCTAssertEqual(Launcher.signInCommandLine, "claude auth login")
    }

    func testSigningInUsesATerminalThatCanBeDrivenWhateverIsChosen() {
        for chosen in ["terminal", "iTerm", "kitty", "alacritty"] {
            XCTAssertEqual(Launcher.signInTerminal(preferred: chosen), chosen)
        }
        for chosen in ["ghostty", "warp", "WezTerm", "", "something-new"] {
            XCTAssertEqual(Launcher.signInTerminal(preferred: chosen), "terminal", chosen)
        }
        for terminal in Launcher.reliableTerminals {
            XCTAssertTrue(Terminals.all.contains { $0.id == terminal }, "\(terminal) is not a terminal the app knows")
        }
    }

    func testTheTerminalScriptSurvivesQuotesAndBackslashesInTheCommand() {
        let nasty = #"cd '/a "b" \c' && laya-claude"#
        let args = Launcher.appleScriptArguments(terminal: "terminal", command: nasty)
        let joined = args.joined(separator: "\n")
        XCTAssertTrue(joined.contains(#"do script "cd '/a \"b\" \\c' && laya-claude""#), joined)
        XCTAssertEqual(args.filter { $0 == "-e" }.count, args.count / 2, "every script is passed as its own -e argument")
    }

    /// Not a string comparison: the escaped text is handed to the real AppleScript parser as a
    /// string literal, and what it evaluates to must be the original command. No app is opened.
    func testTheEscapedCommandRoundTripsThroughTheRealAppleScriptParser() throws {
        let samples = [
            "claude auth login",
            #"cd '/a "b" \c' && laya-claude"#,
            "cd '/it'\\''s' && laya-claude",
            "cd '/Users/me/my project' && laya-claude --continue",
            "cd '/héllo/日本語' && laya-claude",
            #"echo "$HOME" `date` \n \t"#,
            #"\"#, #"\\"#, #"""#, #"\""#, #""\"#,
        ]
        for sample in samples {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            p.arguments = ["-e", "return \"\(Launcher.escape(sample))\""]
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            try p.run()
            p.waitUntilExit()
            let printed = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let complaint = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            XCTAssertEqual(p.terminationStatus, 0, "AppleScript refused \(sample): \(complaint)")
            XCTAssertEqual(printed.trimmingCharacters(in: .newlines), sample, "came back different")
        }
    }

    func testTheTerminalScriptIsNotBuiltThroughAShell() {
        // The arguments go straight to osascript. A shell in between would make a folder name
        // containing an apostrophe end the quoting early.
        let args = Launcher.appleScriptArguments(terminal: "terminal", command: "cd '/it'\\''s' && laya-claude")
        XCTAssertFalse(args.contains { $0.hasPrefix("osascript") }, "the program name is not one of its own arguments")
        XCTAssertTrue(args.first == "-e")
    }

    func testITermGetsItsOwnScriptAndNobodyElseGetsOne() {
        XCTAssertTrue(Launcher.appleScriptArguments(terminal: "iTerm", command: "x").joined().contains("iTerm"))
        XCTAssertTrue(Launcher.appleScriptArguments(terminal: "terminal", command: "x").joined().contains("Terminal"))
        XCTAssertEqual(Launcher.appleScriptArguments(terminal: "kitty", command: "x"), [])
    }

    // MARK: - the views do not decide this themselves

    func testNoViewReadsTheRawStateOrWritesTheCommandItself() throws {
        let views = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/LayaBar")
        for name in ["LayaBar.swift", "SettingsView.swift", "HomeView.swift", "HistoryView.swift", "UsageView.swift", "AlertSettings.swift", "AccountCard.swift"] {
            let text = try String(contentsOf: views.appendingPathComponent(name), encoding: .utf8)
            XCTAssertFalse(text.contains("\"signed-out\""), "\(name) decides sign-in by itself")
            XCTAssertFalse(text.contains("\"signed-in\""), "\(name) decides sign-in by itself")
            XCTAssertFalse(text.contains("claude auth"), "\(name) writes the sign-in command itself")
            XCTAssertFalse(text.contains("npm install"), "\(name) writes the install command itself")
        }
    }
}
