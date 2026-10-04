import XCTest
@testable import LayaBar

/// The fields added for trimming, the guard and the file ranking tool, as the daemon sends them.
final class NewPrefsTests: XCTestCase {
    private let base = #"{"enabled":true,"preset":"balanced","tiers":{"haiku":true,"sonnet":true,"opus":true,"fable":false},"effortAuto":true,"pausedTier":"opus","baselineTier":"opus","showPrompts":true,"launch":{"engine":"claude","terminal":"terminal","resume":false,"dir":null}"#

    func testAbsentFieldsMeanTheDaemonDefaults() throws {
        let p = try JSONDecoder().decode(Snapshot.Prefs.self, from: Data((base + "}").utf8))
        XCTAssertTrue(p.trimOn)
        XCTAssertFalse(p.guardOn)
        XCTAssertFalse(p.rankFilesOn)
    }

    func testGuardDecodesFromItsJSONName() throws {
        let p = try JSONDecoder().decode(Snapshot.Prefs.self, from: Data((base + #","guard":true,"rankFiles":true,"trimToolResults":false}"#).utf8))
        XCTAssertTrue(p.guardOn)
        XCTAssertTrue(p.rankFilesOn)
        XCTAssertFalse(p.trimOn)
    }

    func testPatchSendsOnlyWhatChanged() throws {
        let json = String(decoding: try JSONEncoder().encode(Snapshot.PrefsPatch(guard_: true)), as: UTF8.self)
        XCTAssertEqual(json, #"{"guard":true}"#)
    }

    func testTrimmedTokensDecodeOnEventsAndToday() throws {
        let e = try JSONDecoder().decode(Snapshot.Event.self, from: Data(#"{"at":1,"kind":"routed","cleared":{"tokens":15562,"toolUses":3}}"#.utf8))
        XCTAssertEqual(e.cleared?.tokens, 15562)
        XCTAssertEqual(EventRow.tokens(15562), "16k")
        XCTAssertEqual(EventRow.tokens(1_260_000), "1.3M")
        let g = try JSONDecoder().decode(Snapshot.Event.self, from: Data(#"{"at":2,"kind":"guard","reason":"blocked: rm on ~/"}"#.utf8))
        XCTAssertEqual(g.kind, "guard")
    }
}
