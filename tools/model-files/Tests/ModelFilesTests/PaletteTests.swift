import AppKit
import XCTest
@testable import ModelFiles

final class PaletteTests: XCTestCase {
    func testDynamicColorsResolvePerAppearanceAndSyntaxGroupsLikeWeb() throws {
        func hex(_ color: NSColor, _ name: NSAppearance.Name) throws -> Int {
            var resolved: NSColor?
            try XCTUnwrap(NSAppearance(named: name)).performAsCurrentDrawingAppearance {
                resolved = color.usingColorSpace(.sRGB)
            }
            let c = try XCTUnwrap(resolved)
            return Int((c.redComponent * 255).rounded()) << 16
                | Int((c.greenComponent * 255).rounded()) << 8
                | Int((c.blueComponent * 255).rounded())
        }
        XCTAssertEqual(try hex(Palette.warning, .aqua), 0xC27C0E)
        XCTAssertEqual(try hex(Palette.warning, .darkAqua), 0xE5B454)
        XCTAssertEqual(try hex(Palette.glyph(.tokenizer), .darkAqua), 0xB79CFF)
        XCTAssertEqual(Palette.syntax("property"), Palette.syntax("attr-name"))
        XCTAssertEqual(Palette.syntax("block-comment"), Palette.syntax("comment"))
        XCTAssertEqual(Palette.syntax("boolean"), Palette.syntax("number"))
        XCTAssertEqual(Palette.syntax("unknown-type"), .labelColor)
    }
}
