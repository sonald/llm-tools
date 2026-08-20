import Foundation
import XCTest
@testable import ModelFiles

final class ChatTemplateCatalogTests: XCTestCase {
    func testParsesStringTemplateAsDefault() throws {
        let catalog = try ChatTemplateCatalog.parse(configData: data(#"{"chat_template":"{{ messages }}"}"#))

        XCTAssertEqual(catalog.entries, [
            ChatTemplateEntry(name: "default", source: .tokenizerConfig, body: "{{ messages }}")
        ])
        XCTAssertEqual(catalog.activeID, "default")
        XCTAssertEqual(catalog.activeEntry?.body, "{{ messages }}")
        XCTAssertTrue(catalog.isAvailable)
        XCTAssertFalse(catalog.conflict)
    }

    func testSortsNamedDictionaryEntriesDeterministically() throws {
        let catalog = try ChatTemplateCatalog.parse(configData: data(#"""
        {
          "chat_template": {
            "first": "first",
            "default": "default",
            "tool_use": "tool"
          }
        }
        """#))

        XCTAssertEqual(catalog.entries.map(\.name), ["default", "first", "tool_use"])
        XCTAssertEqual(catalog.activeID, "default")
        XCTAssertEqual(catalog.activeEntry?.body, "default")
    }

    func testSkipsEmptyDefaultAndSelectsFirstAvailableEntry() throws {
        let catalog = try ChatTemplateCatalog.parse(configData: data(#"""
        {
          "chat_template": {
            "first": "first",
            "default": " \n\t",
            "tool_use": "tool"
          }
        }
        """#))

        XCTAssertEqual(catalog.activeID, "first")
        XCTAssertEqual(catalog.activeEntry?.body, "first")
    }

    func testParsesNamedArrayAndFallsBackFromEmptySelectedEntry() throws {
        let catalog = try ChatTemplateCatalog.parse(configData: data(#"""
        {
          "chat_template": [
            {"name": "default", "template": " "},
            {"name": "tool_use", "template": "tool"},
            {"name": "later", "template": "later"}
          ]
        }
        """#))

        XCTAssertEqual(catalog.entries.map(\.name), ["default", "tool_use", "later"])
        XCTAssertEqual(catalog.activeID, "tool_use")
        XCTAssertEqual(catalog.activeEntry?.body, "tool")
    }

    func testAllEmptyTemplatesMakeChatUnavailable() throws {
        let catalog = try ChatTemplateCatalog.parse(configData: data(#"""
        {
          "chat_template": [
            {"name": "default", "template": ""},
            {"name": "tool_use", "template": " \n"}
          ]
        }
        """#))

        XCTAssertNil(catalog.activeID)
        XCTAssertNil(catalog.activeEntry)
        XCTAssertFalse(catalog.isAvailable)
    }

    func testRequestedEmptyEntryFallsBackToNextUsableEntry() {
        let catalog = ChatTemplateCatalog(
            entries: [
                ChatTemplateEntry(name: "default", source: .tokenizerConfig, body: "default"),
                ChatTemplateEntry(name: "tool_use", source: .tokenizerConfig, body: " "),
                ChatTemplateEntry(name: "later", source: .tokenizerConfig, body: "later")
            ],
            activeID: "tool_use"
        )

        XCTAssertEqual(catalog.activeID, "later")
        XCTAssertEqual(catalog.activeEntry?.body, "later")
    }

    func testUnknownTemplateShapesThrowExplicitErrors() {
        for source in [
            #"{"chat_template": 42}"#,
            #"{"chat_template": null}"#,
            #"{"chat_template": [{"name": "missing-template"}]}"#,
            #"{"chat_template": [{"name": "bad", "template": 1}]}"#
        ] {
            XCTAssertThrowsError(try ChatTemplateCatalog.parse(configData: data(source)), source)
        }
    }

    private func data(_ source: String) -> Data {
        Data(source.utf8)
    }
}
