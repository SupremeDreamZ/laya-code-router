import AppKit
import XCTest
@testable import LayaBar

/// The panel is dark whatever the Mac is set to.
///
/// Found 2026-10-01 by capturing the real panel with the Mac in light mode: the header icons and the
/// "how eagerly it saves" picker drew in dark ink on the dark panel and could not be seen.
final class PanelAppearanceTests: XCTestCase {
    func testThePanelIsAlwaysDark() {
        XCTAssertEqual(PanelAppearance.forced?.name, .darkAqua)
    }

    /// The two light appearances must not be what the panel resolves to, which is the failure that was seen.
    func testItIsNotEitherLightAppearance() {
        XCTAssertNotEqual(PanelAppearance.forced?.name, .aqua)
        XCTAssertNotEqual(PanelAppearance.forced?.name, .vibrantLight)
    }

    /// The window the app actually opens, not just the constant: this is the line whose removal brought the bug back.
    @MainActor
    func testTheRealPanelIsDark() {
        let panel = PanelShell.make()
        XCTAssertEqual(panel.appearance?.name, .darkAqua)
        XCTAssertEqual(panel.level, .statusBar)
    }
}
