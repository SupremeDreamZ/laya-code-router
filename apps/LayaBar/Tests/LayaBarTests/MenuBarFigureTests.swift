import AppKit
import XCTest
@testable import LayaBar

/// What sits beside the menu-bar icon.
///
/// Found on a real Mac (2026-09-30): the option was on, the daemon was healthy, and nothing appeared.
/// The figure is read from the plan-limit headers on responses that pass through Laya, and the only
/// 5-hour reading was from before the current window began, so it was correctly dropped, leaving
/// nothing to draw. Drawing nothing is also exactly what a switched-off option looks like, so
/// "nothing to show yet" and "off" were indistinguishable and the toggle looked broken.
final class MenuBarFigureTests: XCTestCase {
    private let now: Double = 1_790_815_000_000
    private let minute: Double = 60_000

    private func window(_ utilization: Double, resetsInMs: Double? = 3 * 3_600_000) -> Snapshot.LimitWindow {
        Snapshot.LimitWindow(utilization: utilization, resetsAt: resetsInMs.map { now + $0 }, status: "allowed", pace: nil)
    }

    private func snapshot(
        on: Bool? = true,
        five: Snapshot.LimitWindow? = nil,
        weekly: Snapshot.LimitWindow? = nil,
        readingAgeMs: Double? = 0
    ) -> Snapshot {
        var s = Snapshot.empty
        s.now = now
        s.prefs.showUsageInMenuBar = on
        var windows: [String: Snapshot.LimitWindow] = [:]
        if let five { windows["5h"] = five }
        if let weekly { windows["7d"] = weekly }
        s.limits = windows.isEmpty ? nil : Snapshot.Limits(windows: windows, status: nil, representative: nil, at: readingAgeMs.map { now - $0 })
        return s
    }

    private func figure(_ s: Snapshot, live: Bool = true) -> MenuBarFigure { MenuBarFigure.make(s, live: live) }

    // MARK: - off means off

    func testOffShowsNothingWhateverTheReadingIs() {
        let s = snapshot(on: false, five: window(0.42))
        XCTAssertEqual(figure(s), .off)
        XCTAssertEqual(figure(s).title, "")
    }

    func testAnOlderDaemonThatNeverSentTheSettingIsOff() {
        let s = snapshot(on: nil, five: window(0.42))
        XCTAssertEqual(figure(s), .off)
    }

    func testNothingIsShownWhileTheDaemonIsNotLive() {
        // `live` is false before the first snapshot arrives, and again whenever the connection drops:
        // the app keeps the last snapshot it had, so without this a figure would sit frozen at the
        // old number while the daemon is down, looking current.
        XCTAssertEqual(figure(snapshot(five: window(0.42)), live: false), .off)
        XCTAssertEqual(figure(snapshot(five: nil), live: false), .off, "and not a dash either")
    }

    // MARK: - on, with a reading

    func testOnWithAFreshReadingShowsTheWholePercent() {
        let f = figure(snapshot(five: window(0.42)))
        XCTAssertEqual(f.title, " 42%")
        XCTAssertFalse(f.dimmed)
        XCTAssertEqual(f.tooltip, "Laya · 42% of your 5-hour limit used")
    }

    func testThePercentRoundsDownLikeEveryOtherPlaceItAppears() {
        XCTAssertEqual(figure(snapshot(five: window(0.999))).title, " 99%")
        XCTAssertEqual(figure(snapshot(five: window(0.0))).title, " 0%")
        XCTAssertEqual(figure(snapshot(five: window(1.0))).title, " 100%")
    }

    func testItIsTheFiveHourWindowAndNotTheWeeklyOne() {
        let f = figure(snapshot(five: window(0.28), weekly: window(0.09)))
        XCTAssertEqual(f.title, " 28%")
    }

    // MARK: - on, with nothing to show: the bug

    func testOnWithNoReadingAtAllShowsADashNotNothing() {
        let f = figure(snapshot(five: nil))
        XCTAssertEqual(f.title, " –%", "empty looked identical to off")
        XCTAssertNotEqual(f, .off)
        XCTAssertTrue(f.dimmed, "it must read as 'no data', not as a figure")
    }

    func testTheTooltipSaysWhatTheFigureNeeds() {
        let f = figure(snapshot(five: nil))
        XCTAssertTrue(f.tooltip.contains("no 5-hour reading"))
        XCTAssertTrue(f.tooltip.contains("signed in with a Claude plan"), "an API key has no plan windows, so this has to say so")
        XCTAssertTrue(f.tooltip.contains("connection to Anthropic"))
        // Laya asks Claude Code for the figure itself now. Telling anyone to send a turn would send
        // them to do something that changes nothing.
        XCTAssertFalse(f.tooltip.contains("next turn"))
        XCTAssertFalse(f.tooltip.contains("through Laya"))
    }

    func testOnlyTheWeeklyReadingBeingThereIsStillNothingToShow() {
        // The real case: after a restart the 7-day figure survives and the 5-hour one does not.
        let f = figure(snapshot(five: nil, weekly: window(0.04)))
        XCTAssertEqual(f.title, " –%")
        XCTAssertTrue(f.dimmed)
    }

    func testAFiveHourReadingPastItsResetIsNotShownAsCurrent() {
        // A window that has already reset no longer describes the plan.
        let f = figure(snapshot(five: window(0.93, resetsInMs: -1)))
        XCTAssertEqual(f.title, " –%")
        XCTAssertTrue(f.dimmed)
    }

    func testAWindowWithNoResetTimeIsStillShown() {
        let f = figure(snapshot(five: window(0.42, resetsInMs: nil)))
        XCTAssertEqual(f.title, " 42%")
    }

    // MARK: - age

    func testAReadingFromAMinuteAgoStillSaysWhenItWasTaken() {
        let f = figure(snapshot(five: window(0.42), readingAgeMs: 3 * minute))
        XCTAssertEqual(f.title, " 42%")
        XCTAssertFalse(f.dimmed, "three minutes old is still current")
        XCTAssertEqual(f.tooltip, "Laya · 42% of your 5-hour limit used, as of 3 min ago")
    }

    func testTheAgeAppearsAtExactlyOneMinute() {
        XCTAssertEqual(figure(snapshot(five: window(0.42), readingAgeMs: 59_999)).tooltip, "Laya · 42% of your 5-hour limit used")
        XCTAssertEqual(figure(snapshot(five: window(0.42), readingAgeMs: 60_000)).tooltip, "Laya · 42% of your 5-hour limit used, as of 1 min ago")
    }

    func testAReadingUnderAMinuteOldDoesNotSayHowOld() {
        let f = figure(snapshot(five: window(0.42), readingAgeMs: 20_000))
        XCTAssertEqual(f.tooltip, "Laya · 42% of your 5-hour limit used")
    }

    func testAnOldReadingIsDimmedAndExplainsWhyItMayBeLow() {
        let f = figure(snapshot(five: window(0.42), readingAgeMs: 40 * minute))
        XCTAssertEqual(f.title, " 42%")
        XCTAssertTrue(f.dimmed)
        XCTAssertTrue(f.tooltip.contains("as of 40 min ago"))
        // The figure is Anthropic's account-wide number, so it is not "missing" turns made elsewhere:
        // Laya asked and got no answer, so it cannot say what the figure is now.
        XCTAssertTrue(f.tooltip.contains("Laya couldn't refresh it"))
        XCTAssertTrue(f.tooltip.contains("may be higher now"))
        XCTAssertFalse(f.tooltip.contains("not counted"), "that claim was wrong: the figure is account-wide")
        XCTAssertFalse(f.tooltip.contains("only updates when a turn"), "Laya no longer waits for a turn to learn the figure")
    }

    func testTheStaleBoundaryIsFifteenMinutesExactly() {
        XCTAssertFalse(figure(snapshot(five: window(0.42), readingAgeMs: 15 * minute - 1)).dimmed)
        XCTAssertTrue(figure(snapshot(five: window(0.42), readingAgeMs: 15 * minute)).dimmed)
        XCTAssertEqual(MenuBarFigure.staleAfterMs, 15 * minute)
    }

    func testAReadingWithNoTimestampIsShownAsCurrentRatherThanGuessedAt() {
        let f = figure(snapshot(five: window(0.42), readingAgeMs: nil))
        XCTAssertEqual(f.title, " 42%")
        XCTAssertFalse(f.dimmed)
        XCTAssertEqual(f.tooltip, "Laya · 42% of your 5-hour limit used")
    }

    func testAClockThatRunsBehindIsNotAnAge() {
        // `at` in the future (a skewed clock) must not become a negative age or a stale flag.
        let f = figure(snapshot(five: window(0.42), readingAgeMs: -5 * minute))
        XCTAssertFalse(f.dimmed)
        XCTAssertEqual(f.tooltip, "Laya · 42% of your 5-hour limit used")
    }

    // MARK: - the three states are three different things

    func testOffEmptyAndShownAreAllDistinctOnScreen() {
        let off = figure(snapshot(on: false))
        let empty = figure(snapshot(five: nil))
        let shown = figure(snapshot(five: window(0.42)))
        XCTAssertEqual(Set([off.title, empty.title, shown.title]).count, 3)
        XCTAssertEqual(Set([off.tooltip, empty.tooltip, shown.tooltip]).count, 3)
    }

    // MARK: - what is drawn

    private func secondary(_ b: NSButton) -> Bool {
        let a = b.attributedTitle
        guard a.length > 0, let c = a.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor else { return false }
        return c == NSColor.secondaryLabelColor
    }

    @MainActor func testAFigureIsDrawnAsPlainTitleWithItsTooltip() {
        let button = NSButton()
        MenuBarFigure.make(snapshot(five: window(0.34)), live: true).apply(to: button)
        XCTAssertEqual(button.title, " 34%")
        XCTAssertEqual(button.toolTip, "Laya · 34% of your 5-hour limit used")
        XCTAssertFalse(secondary(button), "a current figure must be drawn in the normal menu-bar colour")
        // Drawn through `title`, AppKit supplies its own font and colour. A bare attributed string
        // carries neither, and the figure would be set in a different typeface from every other item.
        let a = button.attributedTitle
        XCTAssertNotNil(a.attribute(.font, at: 0, effectiveRange: nil), "the figure has no font of its own")
        XCTAssertNotNil(a.attribute(.foregroundColor, at: 0, effectiveRange: nil), "the figure has no colour of its own")
    }

    @MainActor func testADimmedFigureIsDrawnInTheSecondaryColour() {
        let button = NSButton()
        MenuBarFigure.make(snapshot(five: nil), live: true).apply(to: button)
        XCTAssertEqual(button.title, " –%")
        XCTAssertTrue(secondary(button), "no reading must not look like a real one")
        XCTAssertTrue(button.toolTip?.contains("no 5-hour reading") == true)
    }

    @MainActor func testAStaleFigureKeepsItsNumberAndIsDimmed() {
        let button = NSButton()
        MenuBarFigure.make(snapshot(five: window(0.42), readingAgeMs: 40 * minute), live: true).apply(to: button)
        XCTAssertEqual(button.title, " 42%")
        XCTAssertTrue(secondary(button))
    }

    @MainActor func testOffDrawsNothingAtAll() {
        let button = NSButton()
        MenuBarFigure.make(snapshot(on: false, five: window(0.42)), live: true).apply(to: button)
        XCTAssertEqual(button.title, "")
        XCTAssertEqual(button.attributedTitle.length, 0)
        XCTAssertEqual(button.toolTip, "Laya router")
    }

    @MainActor func testAReadingArrivingTakesTheDimmingOff() {
        // The real sequence: the dash is shown, a turn goes through, the figure replaces it. If the
        // grey stayed, a current figure would look stale forever.
        let button = NSButton()
        MenuBarFigure.make(snapshot(five: nil), live: true).apply(to: button)
        XCTAssertTrue(secondary(button))
        MenuBarFigure.make(snapshot(five: window(0.34)), live: true).apply(to: button)
        XCTAssertEqual(button.title, " 34%")
        XCTAssertFalse(secondary(button), "the dimming outlived the dash")
    }

    @MainActor func testAFigureGoingStaleIsDimmedAgain() {
        let button = NSButton()
        MenuBarFigure.make(snapshot(five: window(0.42)), live: true).apply(to: button)
        XCTAssertFalse(secondary(button))
        MenuBarFigure.make(snapshot(five: window(0.42), readingAgeMs: 40 * minute), live: true).apply(to: button)
        XCTAssertTrue(secondary(button))
    }

    @MainActor func testTurningTheOptionOffClearsAFigureThatWasShowing() {
        let button = NSButton()
        MenuBarFigure.make(snapshot(five: nil), live: true).apply(to: button)
        MenuBarFigure.make(snapshot(on: false), live: true).apply(to: button)
        XCTAssertEqual(button.title, "")
        XCTAssertEqual(button.attributedTitle.length, 0)
        XCTAssertEqual(button.toolTip, "Laya router")
    }

    @MainActor func testTheMenuBarFontIsKeptWhenDimmed() {
        let button = NSButton()
        MenuBarFigure.make(snapshot(five: nil), live: true).apply(to: button)
        let font = button.attributedTitle.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        XCTAssertEqual(font, NSFont.menuBarFont(ofSize: 0), "an attributed title with no font falls back to a different typeface")
    }

    @MainActor func testApplyingTheSameFigureTwiceChangesNothing() {
        let button = NSButton()
        let f = MenuBarFigure.make(snapshot(five: window(0.34)), live: true)
        f.apply(to: button)
        let first = (button.title, button.toolTip, button.attributedTitle)
        f.apply(to: button)
        XCTAssertEqual(button.title, first.0)
        XCTAssertEqual(button.toolTip, first.1)
        XCTAssertEqual(button.attributedTitle, first.2)
    }

    // MARK: - the figure follows the clock

    func testAFigureIsJudgedAtTheMomentItIsAskedAbout() {
        // The same snapshot, read at three moments. This is what lets a bar nobody pushed to stay true.
        let s = snapshot(five: window(0.42, resetsInMs: 3_600_000), readingAgeMs: 0)
        XCTAssertEqual(figure(s).title, " 42%")
        XCTAssertFalse(figure(s).dimmed)
        let later = s.advanced(to: now + 20 * minute)
        XCTAssertEqual(figure(later).title, " 42%")
        XCTAssertTrue(figure(later).dimmed, "twenty minutes with no answer: it may have moved")
        XCTAssertTrue(figure(later).tooltip.contains("as of 20 min ago"))
        let over = s.advanced(to: now + 2 * 3_600_000)
        XCTAssertEqual(figure(over).title, " –%", "a window that has ended is not a figure")
        XCTAssertTrue(figure(over).dimmed)
    }

    func testTheClockMovesForwardAndNeverBack() {
        let s = snapshot(five: window(0.42, resetsInMs: 3_600_000), readingAgeMs: 40 * minute)
        XCTAssertEqual(s.advanced(to: now + minute).now, now + minute)
        XCTAssertEqual(s.advanced(to: now).now, now)
        // An app clock behind the daemon's must not make an old reading fresh again.
        let behind = s.advanced(to: now - 30 * minute)
        XCTAssertEqual(behind.now, now)
        XCTAssertTrue(figure(behind).dimmed)
    }

    func testAdvancingChangesTheClockAndNothingElse() {
        let s = snapshot(five: window(0.42), weekly: window(0.1), readingAgeMs: 0)
        var moved = s.advanced(to: now + 5 * minute)
        XCTAssertNotEqual(moved, s)
        moved.now = s.now
        XCTAssertEqual(moved, s)
    }

    func testTheAppDelegateRejudgesOnATimer() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/LayaBar/LayaBar.swift")
        let text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(text.contains("Timer.publish(every: 30, on: .main, in: .common)"),
                      "the bar is drawn only when the daemon pushes, and a quiet daemon pushes nothing")
        XCTAssertTrue(text.contains(".advanced(to: Date().timeIntervalSince1970 * 1000)"),
                      "the timer must move the clock the figure is judged against, or it redraws the same thing")
        XCTAssertTrue(text.contains("live: self.client.live"), "and must still respect whether the daemon is connected")
    }

    // MARK: - nothing still promises a turn

    func testNoCopyStillSaysTheFigureNeedsATurnThroughLaya() throws {
        // Laya asks Claude Code for the figure itself. Any sentence that says otherwise sends a person
        // to do something that changes nothing, and is checked in every file rather than the one that
        // was edited when this was found.
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/LayaBar")
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil).filter { $0.pathExtension == "swift" }
        XCTAssertGreaterThan(files.count, 10, "this is looking at the sources")
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for claim in ["Shows up after your next turn", "appears after your next turn", "next turn through Laya", "only updates when a turn", "stays empty until a turn"] {
                XCTAssertFalse(text.contains(claim), "\(file.lastPathComponent) still says: \(claim)")
            }
        }
    }

    // MARK: - wiring

    func testTheAppDelegateUsesThisAndDoesNotDecideItsOwn() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/LayaBar/LayaBar.swift")
        let text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(text.contains("MenuBarFigure.make(snapshot, live: live).apply(to: button)"),
                      "the delegate must pass the real `live` flag, and hand the result to the one function that draws it")
        XCTAssertTrue(text.contains("MenuBarFigure.make("), "the delegate must draw what MenuBarFigure decided")
        XCTAssertTrue(text.contains(".apply(to: button)"), "and must hand it to the one function that draws it")
        XCTAssertFalse(text.contains("button.title"), "the delegate sets the title itself again")
        XCTAssertFalse(text.contains("attributedTitle"), "the delegate styles the title itself again")
        XCTAssertFalse(text.contains("button.toolTip"), "the delegate sets the tooltip itself again")
        // The figure must follow the CONNECTION as well as the snapshot. The app keeps the last
        // snapshot it had when the daemon goes away, so without `live` a stale number would sit on
        // screen looking current.
        XCTAssertTrue(text.contains(".combineLatest(client.$live)"), "the figure no longer follows whether the daemon is connected")
        XCTAssertFalse(text.contains("live: true"), "the delegate pretends the daemon is always connected")
        XCTAssertFalse(text.contains("\\(pct)%"), "the delegate formats the percentage itself again")
        XCTAssertFalse(text.contains("5-hour limit used"), "the delegate words the tooltip itself again")
    }
}
