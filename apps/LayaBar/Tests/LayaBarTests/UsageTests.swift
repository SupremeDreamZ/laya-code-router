import XCTest
import UserNotifications
@testable import LayaBar

/// Percent, severity, countdowns and the reconnect and de-dupe rules: everything in the usage
/// display that is arithmetic or wording, tested without a window.
final class UsageTests: XCTestCase {
    // MARK: - percent

    func testPercentIsWholeAndRoundsDownLikeTheDaemonDoes() {
        XCTAssertEqual(Usage.percent(0), 0)
        XCTAssertEqual(Usage.percent(0.01), 1)
        XCTAssertEqual(Usage.percent(0.75), 75)
        XCTAssertEqual(Usage.percent(0.999), 99)
        XCTAssertEqual(Usage.percent(1), 100)
        XCTAssertEqual(Usage.percent(1.04), 104, "going over is shown, not clamped")
    }

    /// 0.29 * 100 is 28.999999999999996 in floating point, so a bare floor shows 28%. The daemon
    /// adds a small epsilon before flooring and the app must do the same, or the bar says 28% while
    /// the alert that fired for it says 29%.
    func testPercentSurvivesFloatingPointNoise() {
        for n in 1...99 {
            XCTAssertEqual(Usage.percent(Double(n) / 100), n, "\(n)%")
        }
    }

    // MARK: - severity

    func testSeverityFollowsTheDefaultThresholds() {
        XCTAssertEqual(Usage.severity(0.50, thresholds: [75, 90]), .calm)
        XCTAssertEqual(Usage.severity(0.74, thresholds: [75, 90]), .calm)
        XCTAssertEqual(Usage.severity(0.75, thresholds: [75, 90]), .warning)
        XCTAssertEqual(Usage.severity(0.89, thresholds: [75, 90]), .warning)
        XCTAssertEqual(Usage.severity(0.90, thresholds: [75, 90]), .critical)
        XCTAssertEqual(Usage.severity(1.00, thresholds: [75, 90]), .critical)
    }

    func testAnEarlyAlertDoesNotPaintAHalfFullBarRed() {
        XCTAssertEqual(Usage.severity(0.50, thresholds: [50]), .warning)
        XCTAssertEqual(Usage.severity(0.80, thresholds: [50]), .warning)
        XCTAssertEqual(Usage.severity(0.90, thresholds: [50]), .critical)
    }

    func testTheBarStaysHonestWhateverIsMuted() {
        XCTAssertEqual(Usage.severity(0.95, thresholds: []), .critical, "no alerts set, but 95% is still nearly out")
        XCTAssertEqual(Usage.severity(0.50, thresholds: []), .calm)
        XCTAssertEqual(Usage.severity(0.92, thresholds: [95]), .calm, "below their own lowest threshold")
        XCTAssertEqual(Usage.severity(0.95, thresholds: [95]), .critical)
    }

    // MARK: - countdown

    func testCountdownWording() {
        XCTAssertEqual(Usage.countdown(ms: 0), "now")
        XCTAssertEqual(Usage.countdown(ms: -5000), "now")
        XCTAssertEqual(Usage.countdown(ms: 20_000), "1 min", "never 0 min")
        XCTAssertEqual(Usage.countdown(ms: 45 * 60_000), "45 min")
        XCTAssertEqual(Usage.countdown(ms: 60 * 60_000), "1 h")
        XCTAssertEqual(Usage.countdown(ms: (3 * 60 + 12) * 60_000), "3 h 12 min")
        XCTAssertEqual(Usage.countdown(ms: 24 * 3_600_000), "1 day")
        XCTAssertEqual(Usage.countdown(ms: 48 * 3_600_000), "2 days")
    }

    func testCountdownNeverSaysSixtyMinutes() {
        XCTAssertEqual(Usage.countdown(ms: 59.6 * 60_000), "1 h")
    }

    // MARK: - names

    func testWindowNames() {
        XCTAssertEqual(Usage.windowName("5h"), "5-hour")
        XCTAssertEqual(Usage.windowName("7d"), "Weekly")
        XCTAssertEqual(Usage.windowName("7d_oi"), "Weekly · oi", "an undocumented window keeps its own suffix, unexplained")
        XCTAssertEqual(Usage.windowName("5h_x"), "5-hour · x")
        XCTAssertEqual(Usage.windowName("30d"), "30d")
        XCTAssertEqual(Usage.windowName("30d_foo"), "30d · foo")
    }

    func testWindowsAreOrderedFiveHourWeeklyThenTheRest() throws {
        let data = try XCTUnwrap(Bundle.module.url(forResource: "snapshot-full", withExtension: "json", subdirectory: "Fixtures"))
        let s = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: data))
        XCTAssertEqual(Usage.orderedWindows(try XCTUnwrap(s.limits)).map(\.key), ["5h", "7d", "7d_oi"])
        let weeklyOnly = try JSONDecoder().decode(Snapshot.Limits.self, from: Data(#"{"windows":{"7d":{"utilization":0.2}}}"#.utf8))
        XCTAssertEqual(Usage.orderedWindows(weeklyOnly).map(\.key), ["7d"])
    }

    // MARK: - reset label

    func testResetLabelShowsTheTimeToday() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let locale = Locale(identifier: "en_US")
        let now = Date(timeIntervalSince1970: 1_790_800_000) // 2026-09-30 20:26 UTC
        let later = (now.timeIntervalSince1970 + 3 * 3600) * 1000
        let label = Usage.resetLabel(resetsAt: later, now: now, calendar: cal, locale: locale).replacingOccurrences(of: "\u{202F}", with: " ")
        XCTAssertEqual(label, "11:26 PM")
    }

    func testResetLabelNamesTheDayWhenItIsNotToday() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let locale = Locale(identifier: "en_US")
        let now = Date(timeIntervalSince1970: 1_790_800_000)
        let later = (now.timeIntervalSince1970 + 2 * 86400) * 1000
        let label = Usage.resetLabel(resetsAt: later, now: now, calendar: cal, locale: locale)
        XCTAssertTrue(label.contains("Fri"), label)
    }

    // MARK: - live windows

    private func limits(_ json: String) throws -> Snapshot.Limits {
        try JSONDecoder().decode(Snapshot.Limits.self, from: Data(json.utf8))
    }

    func testAWindowPastItsResetIsNotShown() throws {
        let l = try limits(#"{"windows":{"5h":{"utilization":0.9,"resetsAt":1000},"7d":{"utilization":0.2,"resetsAt":9000}}}"#)
        XCTAssertEqual(Usage.live(l, nowMs: 500).map(\.key), ["5h", "7d"])
        XCTAssertEqual(Usage.live(l, nowMs: 1000).map(\.key), ["7d"], "at the reset moment it is over")
        XCTAssertEqual(Usage.live(l, nowMs: 5000).map(\.key), ["7d"])
        XCTAssertEqual(Usage.live(l, nowMs: 9500).map(\.key), [])
    }

    func testAWindowWithNoResetTimeIsKept() throws {
        let l = try limits(#"{"windows":{"5h":{"utilization":0.4}}}"#)
        XCTAssertEqual(Usage.live(l, nowMs: 1e15).map(\.key), ["5h"])
    }

    func testNoLimitsMeansNoWindows() {
        XCTAssertEqual(Usage.live(nil, nowMs: 0).count, 0)
    }

    // MARK: - age

    func testAge() {
        XCTAssertEqual(Usage.age(ms: 0), "just now")
        XCTAssertEqual(Usage.age(ms: 45_000), "just now")
        XCTAssertEqual(Usage.age(ms: -1000), "just now", "a clock that is slightly behind is not the future")
        XCTAssertEqual(Usage.age(ms: 4 * 60_000), "4 min ago")
        XCTAssertEqual(Usage.age(ms: 3 * 3_600_000), "3 h ago")
    }

    // MARK: - starting the background router

    func testLaunchctlCommandsAreBuiltForTheRightServiceAndUser() {
        XCTAssertEqual(DaemonControl.kickstart(uid: 501), ["kickstart", "gui/501/io.github.supremedreamz.laya"])
        XCTAssertEqual(DaemonControl.bootstrap(uid: 501, plist: "/x/y.plist"), ["bootstrap", "gui/501", "/x/y.plist"])
    }

    /// The label lives in two places: the plist install.sh writes and the constant the app uses to
    /// restart it. If they drift apart the app silently restarts nothing.
    func testTheLabelMatchesWhatTheInstallerWrites() throws {
        let installer = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("install.sh")
        let text = try String(contentsOf: installer, encoding: .utf8)
        XCTAssertTrue(text.contains("<key>Label</key><string>\(DaemonControl.label)</string>"), "install.sh does not write the label the app restarts")
        XCTAssertTrue(text.contains("\(DaemonControl.label).plist"), "install.sh does not write the plist file the app bootstraps")
    }

    func testAQuitDoesNotComeBackByItself() throws {
        let installer = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("install.sh")
        let text = try String(contentsOf: installer, encoding: .utf8)
        // KeepAlive=true restarts the daemon the instant it exits, so "Quit" would never stick.
        // (Measured with a throwaway job: started 6 times in 6 seconds after exiting 0.)
        XCTAssertFalse(text.contains("<key>KeepAlive</key><true/>"))
        XCTAssertTrue(text.contains("<key>SuccessfulExit</key><false/>"), "a crash is restarted, a clean quit is not")
    }

    // MARK: - recent activity (for the quit confirmation)

    func testASessionCountsAsActiveForFiveMinutes() {
        XCTAssertTrue(Usage.recentlyActive(lastEventAt: 1_000_000, nowMs: 1_000_000 + 4 * 60_000))
        XCTAssertFalse(Usage.recentlyActive(lastEventAt: 1_000_000, nowMs: 1_000_000 + 6 * 60_000))
        XCTAssertFalse(Usage.recentlyActive(lastEventAt: nil, nowMs: 5))
    }

    // MARK: - money

    func testCostKeepsPrecisionBelowACent() {
        XCTAssertEqual(Money.short(0.0067542), "$0.0068", "the real Haiku turn from 2026-09-30; a cheap turn is not shown as free")
        XCTAssertEqual(Money.short(0.0068), "$0.0068")
        XCTAssertEqual(Money.short(0.00001), "$0.0000", "below a hundredth of a cent it rounds to nothing, but still shows four places")
        XCTAssertEqual(Money.short(0.0099), "$0.0099")
        XCTAssertEqual(Money.short(0.01), "$0.01")
        XCTAssertEqual(Money.short(0.0254), "$0.03")
        XCTAssertEqual(Money.short(12.5), "$12.50")
        XCTAssertEqual(Money.short(0), "$0.0000")
    }

    func testAnEventCarriesTheDaemonsCostAndNoPriceTableLivesInTheApp() throws {
        let s = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: XCTUnwrap(Bundle.module.url(forResource: "snapshot-full", withExtension: "json", subdirectory: "Fixtures"))))
        let priced = try XCTUnwrap(s.events.first { $0.usage != nil })
        XCTAssertNotNil(priced.cost, "the daemon prices each event")
        XCTAssertGreaterThan(try XCTUnwrap(priced.cost), 0)
        XCTAssertNil(s.events.first { $0.usage == nil }?.cost, "and leaves it out when usage was not read")
        // The bug this replaces: HomeView kept its own copy of the rates and charged Haiku 3x the
        // ledger's price. If a rate table reappears in the views, this fails.
        let views = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/LayaBar")
        for file in try FileManager.default.contentsOfDirectory(at: views, includingPropertiesForKeys: nil) where file.pathExtension == "swift" {
            let text = try String(contentsOf: file, encoding: .utf8)
            XCTAssertFalse(text.contains("0.5 + 2.5"), "\(file.lastPathComponent) carries its own prices again")
            XCTAssertFalse(text.contains("cacheRead * 0.1"), "\(file.lastPathComponent) prices tokens itself")
        }
    }

    // MARK: - notification permission

    func testEveryAuthorizationStatusMapsToSomethingTheUserCanActOn() {
        XCTAssertEqual(NotifyAccess(.notDetermined), .unknown)
        XCTAssertEqual(NotifyAccess(.denied), .blocked)
        XCTAssertEqual(NotifyAccess(.authorized), .allowed)
        XCTAssertEqual(NotifyAccess(.provisional), .allowed)
    }

    func testTheSettingsMessageSaysWhatIsWrongAndWhatStillWorks() throws {
        XCTAssertNil(NotifyAccess.allowed.message, "nothing to say when it works")
        let blocked = try XCTUnwrap(NotifyAccess.blocked.message)
        XCTAssertTrue(blocked.contains("System Settings"), "it says where to fix it")
        XCTAssertTrue(blocked.contains("panel"), "and that alerts still show in the panel")
        XCTAssertNotNil(NotifyAccess.unknown.message)
        XCTAssertNotEqual(NotifyAccess.unknown.message, NotifyAccess.blocked.message)
    }

    func testOnlyAStateThatNeedsFixingOffersAButton() {
        XCTAssertTrue(NotifyAccess.blocked.canOpenSettings)
        XCTAssertTrue(NotifyAccess.unknown.canOpenSettings, "a prompt that was ignored never comes back, so Settings is the way")
        XCTAssertFalse(NotifyAccess.allowed.canOpenSettings)
    }

    func testTheSystemSettingsLinkIsAValidURL() {
        XCTAssertNotNil(URL(string: NotifyAccess.settingsURL))
        XCTAssertTrue(NotifyAccess.settingsURL.hasPrefix("x-apple.systempreferences:"))
    }

    // MARK: - what the router card and the status dot say

    private func router(_ state: String, error: String? = nil, proxy: Bool = true) -> RouterStatus {
        RouterStatus(sidecar: .init(state: state, since: nil, lastError: error), proxyRunning: proxy)
    }

    func testAWarmModelIsWhatMakesItSayReady() {
        let r = router("warm")
        XCTAssertEqual(r.headline, "Ready")
        XCTAssertEqual(r.dot, .ready)
        XCTAssertNil(r.problem)
    }

    /// The bug: "Running - Warm model in memory" was shown whenever the proxy existed, which is also
    /// true with no model loaded and with a model that failed to start.
    func testAProxyAloneIsNotAWarmModel() {
        for state in ["stopped", "starting"] {
            let r = router(state)
            XCTAssertNotEqual(r.headline, "Ready", state)
            XCTAssertFalse(r.detail.contains("Warm model in memory"), "\(state): \(r.detail)")
        }
    }

    func testStoppedAndStartingSayWhatIsHappeningAndHowLongToWait() {
        XCTAssertEqual(router("stopped").headline, "Waiting for your first turn")
        XCTAssertEqual(router("stopped").dot, .idle)
        XCTAssertEqual(router("starting").headline, "Loading the routing model")
        XCTAssertEqual(router("starting").dot, .loading)
        XCTAssertTrue(router("starting").detail.contains("minute"), "it sets an expectation, since the first load is slow")
    }

    func testAnErrorShowsTheDaemonsOwnExplanationVerbatim() throws {
        let why = "The Python at /usr/bin/python3 does not have the laya package. Install it with: /usr/bin/python3 -m pip install laya"
        let r = router("error", error: why)
        XCTAssertEqual(r.headline, "Routing is not working")
        XCTAssertEqual(r.dot, .failed)
        XCTAssertEqual(r.problem, why, "the words the daemon chose are shown as they are")
    }

    func testAnErrorWithNoMessageStillSaysSomething() throws {
        let r = router("error", error: nil)
        XCTAssertEqual(r.dot, .failed)
        XCTAssertFalse(try XCTUnwrap(r.problem).isEmpty)
        XCTAssertEqual(router("error", error: "").problem?.isEmpty, false)
    }

    func testEveryStateHasAHeadlineAndAnUnknownOneIsNeverBlank() {
        for state in ["stopped", "starting", "warm", "error", "something-new"] {
            XCTAssertFalse(router(state).headline.isEmpty, state)
            XCTAssertFalse(router(state).detail.isEmpty, state)
        }
        XCTAssertEqual(router("something-new").dot, .idle, "a state from a newer daemon is shown calmly, not as a failure")
    }

    func testAStoppedProxyIsSaidToBeOffRegardlessOfTheModel() {
        let r = router("warm", proxy: false)
        XCTAssertEqual(r.headline, "Stopped")
        XCTAssertEqual(r.dot, .off)
    }

    func testTheButtonFollowsTheProxyNotTheModel() {
        XCTAssertEqual(router("error", proxy: true).buttonTitle, "Stop")
        XCTAssertEqual(router("warm", proxy: false).buttonTitle, "Start")
    }

    func testTheButtonsLabelAndActionNeverDisagree() {
        for state in ["stopped", "starting", "warm", "error"] {
            for proxy in [true, false] {
                let r = router(state, proxy: proxy)
                XCTAssertEqual(r.buttonTitle == "Stop", r.buttonStops, "\(state) proxy=\(proxy)")
            }
        }
    }

    func testTheDotIsNeverColourOnly() {
        // Each state has its own shape description for VoiceOver, so colour is not the only signal.
        let labels = Set([RouterStatus.Dot.ready, .loading, .failed, .idle, .off].map(\.accessibilityLabel))
        XCTAssertEqual(labels.count, 5)
    }

    /// How the bug got in: each view decided for itself what "running" meant. If a view reads the
    /// proxy or the raw sidecar state again, the dot and the card can disagree, and "warm" can be
    /// claimed with nothing behind it.
    func testNoViewDecidesForItselfWhetherTheModelIsWorking() throws {
        let views = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/LayaBar")
        for name in ["LayaBar.swift", "SettingsView.swift", "HomeView.swift", "HistoryView.swift", "UsageView.swift", "AlertSettings.swift"] {
            let text = try String(contentsOf: views.appendingPathComponent(name), encoding: .utf8)
            XCTAssertFalse(text.contains("Warm model in memory"), "\(name) claims a warm model by itself")
            XCTAssertFalse(text.contains("sidecar.state"), "\(name) reads the raw sidecar state instead of RouterStatus")
            XCTAssertFalse(text.contains("state == \"warm\""), "\(name) decides 'warm' by itself")
            XCTAssertFalse(text.contains("anyRunning ?"), "\(name) uses the proxy as a stand-in for the model")
        }
    }

    func testPausedRoutingTakesPrecedenceOverTheDot() {
        XCTAssertEqual(router("warm").dot(routingOn: false), .off)
        XCTAssertEqual(router("error").dot(routingOn: false), .off, "paused is paused, even with a broken model")
        XCTAssertEqual(router("warm").dot(routingOn: true), .ready)
    }

    // MARK: - alert de-dupe

    private func alert(_ id: String) -> Snapshot.Alert {
        .init(id: id, at: 0, kind: "threshold", level: "warning", window: "5h", threshold: 75, pct: 75, title: "t", body: "b", test: nil)
    }

    func testTheFirstSnapshotIsRememberedNotReplayed() {
        var feed = AlertFeed()
        XCTAssertEqual(feed.fresh([alert("a"), alert("b")]), [], "reopening the app must not replay yesterday's alerts")
        XCTAssertEqual(feed.fresh([alert("a"), alert("b")]), [])
    }

    func testOnlyNewAlertsAreDelivered() {
        var feed = AlertFeed()
        _ = feed.fresh([alert("a")])
        XCTAssertEqual(feed.fresh([alert("a"), alert("b")]).map(\.id), ["b"])
        XCTAssertEqual(feed.fresh([alert("a"), alert("b")]), [])
        XCTAssertEqual(feed.fresh([alert("a"), alert("b"), alert("c"), alert("d")]).map(\.id), ["c", "d"])
    }

    /// The app starts with an empty placeholder snapshot. Priming on that would make the first real
    /// one look like a flood of new alerts.
    func testAPlaceholderSnapshotBeforeTheDaemonAnswersDoesNotPrimeTheFeed() {
        var feed = AlertFeed()
        XCTAssertEqual(feed.fresh([], live: false), [])
        XCTAssertFalse(feed.primed)
        XCTAssertEqual(feed.fresh([alert("old1"), alert("old2")], live: true), [], "the first REAL snapshot is the baseline")
        XCTAssertEqual(feed.fresh([alert("old1"), alert("old2"), alert("new")], live: true).map(\.id), ["new"])
    }

    func testAnAlertRaisedWhileDisconnectedIsDeliveredOnReconnect() {
        var feed = AlertFeed()
        _ = feed.fresh([alert("a")], live: true)
        XCTAssertEqual(feed.fresh([alert("a"), alert("while-away")], live: true).map(\.id), ["while-away"])
    }

    func testTheSeenSetStaysBoundedAndNeverRepeatsAnAlert() {
        var feed = AlertFeed()
        var delivered: [String] = []
        var window: [Snapshot.Alert] = []
        _ = feed.fresh([], live: true)
        for i in 0..<2000 {
            window.append(alert("id-\(i)"))
            if window.count > 30 { window.removeFirst() }
            delivered += feed.fresh(window).map(\.id)
            XCTAssertLessThanOrEqual(feed.seen.count, 400)
        }
        XCTAssertEqual(delivered.count, 2000)
        XCTAssertEqual(Set(delivered).count, 2000, "no alert was ever delivered twice across the trim")
    }

    // MARK: - reconnect

    func testBackoffStartsQuickThenSettles() {
        var b = Backoff()
        XCTAssertEqual([b.next(), b.next(), b.next(), b.next(), b.next(), b.next(), b.next()], [0.5, 1, 2, 4, 8, 15, 15])
    }

    func testBackoffResetsAfterASuccess() {
        var b = Backoff()
        _ = b.next(); _ = b.next(); _ = b.next()
        b.reset()
        XCTAssertEqual(b.next(), 0.5)
    }

    func testBackoffNeverOverflowsOrExceedsItsCeiling() {
        var b = Backoff()
        for _ in 0..<10_000 { XCTAssertLessThanOrEqual(b.next(), Backoff.ceiling) }
    }
}
