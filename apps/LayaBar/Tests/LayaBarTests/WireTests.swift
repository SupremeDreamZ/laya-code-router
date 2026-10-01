import XCTest
@testable import LayaBar

/// The app and the daemon are two programs that only meet on a socket, so the shape of what the
/// daemon sends is the contract. These tests decode snapshots the real daemon produced
/// (scripts/make-swift-fixture.mjs), not ones written by hand: rename a field in the daemon and
/// the fixture changes and a test here fails, instead of the panel quietly going blank.
final class WireTests: XCTestCase {
    func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"), "missing fixture \(name)")
        return try Data(contentsOf: url)
    }

    func line(id: Int?, key: String, body: Data) -> Data {
        var s = "{"
        if let id { s += "\"id\":\(id),"}
        s += "\"\(key)\":" + String(decoding: body, as: UTF8.self) + "}"
        return Data(s.utf8)
    }

    // MARK: - the real snapshot

    func testFullSnapshotDecodesEveryNewField() throws {
        let s = try JSONDecoder().decode(Snapshot.self, from: fixture("snapshot-full"))
        let limits = try XCTUnwrap(s.limits)
        XCTAssertEqual(limits.fiveHour?.utilization, 0.93)
        XCTAssertEqual(limits.weekly?.utilization, 0.12)
        XCTAssertEqual(limits.fiveHour?.status, "allowed")
        XCTAssertEqual(limits.representative, "5h")
        XCTAssertNotNil(limits.fiveHour?.pace, "93% used 2h into the window is on pace to run out")
        XCTAssertNil(limits.weekly?.pace)
        XCTAssertEqual(limits.other.map(\.key), ["7d_oi"], "the window seen on a Fable request is kept, not dropped")
    }

    func testAlertsDecodeInOrderWithTheirLevels() throws {
        let s = try JSONDecoder().decode(Snapshot.self, from: fixture("snapshot-full"))
        XCTAssertEqual(s.alertList.map(\.kind), ["threshold", "threshold", "test"])
        XCTAssertEqual(s.alertList[0].threshold, 75)
        XCTAssertEqual(s.alertList[1].level, "critical")
        XCTAssertEqual(s.alertList[1].pct, 93)
        XCTAssertEqual(s.alertList.last?.test, true)
        XCTAssertEqual(Set(s.alertList.map(\.id)).count, 3, "ids are unique, which is what the de-dupe relies on")
    }

    func testEveryModelIsListedEvenWhenSwitchedOff() throws {
        let s = try JSONDecoder().decode(Snapshot.self, from: fixture("snapshot-full"))
        XCTAssertEqual(s.models.map(\.tier), ["haiku", "sonnet", "opus", "fable"])
        XCTAssertEqual(s.tiers, ["haiku", "sonnet", "opus"], "Fable starts off")
        XCTAssertFalse(s.prefs.tier("fable"))
    }

    func testAlertPrefsAndMenuBarFigureDecode() throws {
        let s = try JSONDecoder().decode(Snapshot.self, from: fixture("snapshot-full"))
        XCTAssertEqual(s.prefs.alertPrefs.thresholds, [75, 90])
        XCTAssertTrue(s.prefs.alertPrefs.enabled)
        XCTAssertTrue(s.prefs.alertPrefs.windows.fiveHour)
        XCTAssertFalse(s.prefs.menuBarUsage)
    }

    func testAnOlderDaemonStillDecodesAndTheUIGetsSensibleDefaults() throws {
        let s = try JSONDecoder().decode(Snapshot.self, from: fixture("snapshot-legacy"))
        XCTAssertNil(s.limits)
        XCTAssertEqual(s.alertList, [])
        XCTAssertEqual(s.prefs.alertPrefs, .standard)
        XCTAssertFalse(s.prefs.menuBarUsage)
        XCTAssertEqual(s.events.first?.kind, "routed", "and the old fields still come through")
        XCTAssertEqual(s.events.first?.prompt, "Add pagination to the users list")
        XCTAssertEqual(s.events.first?.usage?.cacheRead, 30000)
    }

    // MARK: - reading a line off the socket

    func testAReplyToASnapshotRequestIsUnderstood() throws {
        let r = try XCTUnwrap(Wire.parse(line(id: 3, key: "result", body: fixture("snapshot-full"))))
        XCTAssertEqual(r.id, 3)
        XCTAssertNotNil(r.snapshot)
        XCTAssertFalse(r.isEvent)
    }

    func testAPushedUpdateIsMarkedAsOneAndKeepsTheSubscribeId() throws {
        let r = try XCTUnwrap(Wire.parse(line(id: 77, key: "event", body: fixture("snapshot-full"))))
        XCTAssertEqual(r.id, 77)
        XCTAssertTrue(r.isEvent)
        XCTAssertNotNil(r.snapshot)
    }

    /// The bug this guards: a reply whose result is not a full snapshot was dropped whole, so the
    /// request that asked for it waited forever. Every reply with an id must come back with it.
    func testAReplyThatIsNotASnapshotStillCarriesItsId() throws {
        let publicReply = try XCTUnwrap(Wire.parse(line(id: 1, key: "result", body: fixture("snapshot-public"))))
        XCTAssertEqual(publicReply.id, 1)
        XCTAssertNil(publicReply.snapshot, "the public reply has no prefs, so it is not a snapshot")
        XCTAssertNil(publicReply.error)

        // What `alerts.test` returns: a single alert, taken from the real fixture.
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("snapshot-full")) as? [String: Any])
        let alerts = try XCTUnwrap(obj["alerts"] as? [[String: Any]])
        let one = try JSONSerialization.data(withJSONObject: try XCTUnwrap(alerts.last))
        let alertReply = try XCTUnwrap(Wire.parse(line(id: 5, key: "result", body: one)))
        XCTAssertEqual(alertReply.id, 5)
        XCTAssertNil(alertReply.snapshot)

        let pong = try XCTUnwrap(Wire.parse(Data(#"{"id":9,"result":{"pong":true}}"#.utf8)))
        XCTAssertEqual(pong.id, 9)
    }

    func testAnErrorReplyCarriesItsMessageAndId() throws {
        let r = try XCTUnwrap(Wire.parse(Data(#"{"id":7,"error":"forbidden"}"#.utf8)))
        XCTAssertEqual(r.id, 7)
        XCTAssertEqual(r.error, "forbidden")
        XCTAssertNil(r.snapshot)
    }

    func testABadLineIsIgnoredNotFatal() {
        XCTAssertNil(Wire.parse(Data("not json".utf8)))
        XCTAssertNil(Wire.parse(Data("[1,2,3]".utf8)))
        XCTAssertNil(Wire.parse(Data()))
        XCTAssertEqual(Wire.parse(Data("{}".utf8))?.id, nil)
    }

    func testAnUnknownFieldFromANewerDaemonIsIgnored() throws {
        var obj = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("snapshot-full")) as? [String: Any])
        obj["somethingFromTheFuture"] = ["a": 1]
        var limits = try XCTUnwrap(obj["limits"] as? [String: Any])
        limits["anotherNewThing"] = true
        obj["limits"] = limits
        let data = try JSONSerialization.data(withJSONObject: obj)
        XCTAssertNoThrow(try JSONDecoder().decode(Snapshot.self, from: data))
    }
}
