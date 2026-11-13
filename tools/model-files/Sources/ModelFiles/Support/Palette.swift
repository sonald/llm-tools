import AppKit
import SwiftUI

/// The few colors the workbench design adds on top of system semantic colors, each with a light and dark value.
/// ponytail: backgrounds stay system materials; the web's custom dark surfaces would fight sidebar vibrancy.
enum Palette {
    static let warning = NSColor(light: 0xC27C0E, dark: 0xE5B454)
    /// Warning text on a tinted background, dark enough for small type in light mode.
    static let warningText = NSColor(light: 0x8A5A00, dark: 0xE5B454)
    static let info = NSColor(light: 0x3478F6, dark: 0x7AA2FF)
    static let ok = NSColor(light: 0x16703A, dark: 0x7FD6A4)

    static func glyph(_ category: FileCategory) -> NSColor {
        switch category {
        case .configuration: NSColor(light: 0x1D4FC4, dark: 0x8FB4FF)
        case .tokenizer: NSColor(light: 0x5B2BC4, dark: 0xB79CFF)
        case .templates: NSColor(light: 0xA63F0B, dark: 0xF0915A)
        case .weightMetadata, .weights: ok
        case .documentation, .other: NSColor(light: 0x5C6068, dark: 0xAAB1BD)
        }
    }

    /// Prism token type → source color, grouped as in the web reader.
    static func syntax(_ type: String) -> NSColor {
        if type.hasPrefix("comment") || type.hasSuffix("-comment") { return syntaxComment }
        switch type {
        case "string", "char", "attr-value", "template-variable", "regex": return syntaxString
        case "number", "boolean", "null", "constant", "builtin", "symbol", "literal": return syntaxLiteral
        case "keyword": return syntaxKeyword
        case "atrule", "tag", "important", "selector", "directive", "preprocessor": return syntaxStructure
        case "function", "function-name", "function-definition", "class-name", "maybe-class-name",
             "property", "attr-name", "attribute", "variable": return syntaxName
        case "operator", "punctuation", "namespace", "url", "entity": return syntaxOperator
        case "inserted": return syntaxString
        case "deleted": return syntaxStructure
        default: return .labelColor
        }
    }

    private static let syntaxComment = NSColor(light: 0x66707D, dark: 0x8D95A3)
    private static let syntaxString = NSColor(light: 0x08743F, dark: 0x9FD9A8)
    private static let syntaxLiteral = NSColor(light: 0x7549C1, dark: 0xD7A8FF)
    private static let syntaxKeyword = NSColor(light: 0x075EC2, dark: 0x71CBDD)
    private static let syntaxName = NSColor(light: 0x096E90, dark: 0x8FB4FF)
    private static let syntaxStructure = NSColor(light: 0xAD321F, dark: 0xFFA287)
    private static let syntaxOperator = NSColor(light: 0x57606A, dark: 0x8D95A3)
}

extension Color {
    static let paletteWarning = Color(nsColor: Palette.warning)
    static let paletteWarningText = Color(nsColor: Palette.warningText)
    static let paletteInfo = Color(nsColor: Palette.info)
    static let paletteOK = Color(nsColor: Palette.ok)

    static func severity(_ severity: ConsistencySeverity) -> Color {
        severity == .warning ? .paletteWarning : .paletteInfo
    }
}

extension NSColor {
    convenience init(light: UInt32, dark: UInt32) {
        self.init(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(
                srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        }
    }
}
