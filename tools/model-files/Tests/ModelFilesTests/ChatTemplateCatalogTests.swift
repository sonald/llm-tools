import Foundation
import XCTest
@testable import ModelFiles

final class ChatTemplateCatalogTests: XCTestCase {
    func testParsesStringTemplateAsDefault() throws {
        let catalog = try ChatTemplateCatalog.parse(configData: data(#"{"chat_template":"{{ messages }}"}"#))

        XCTAssertEqual(catalog.entries, [
            ChatTemplateEntry(name: "default", source: .tokenizerConfig, body: "{{ messages }}")
        ])
        XCTAssertEqual(catalog.activeID, "tokenizerConfig:default")
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
        XCTAssertEqual(catalog.activeID, "tokenizerConfig:default")
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

        XCTAssertEqual(catalog.activeID, "tokenizerConfig:first")
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
        XCTAssertEqual(catalog.activeID, "tokenizerConfig:tool_use")
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
            activeID: "tokenizerConfig:tool_use"
        )

        XCTAssertEqual(catalog.activeID, "tokenizerConfig:later")
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

    func testJinjaIsTheDefaultSourceWhenConfigAlsoHasTemplates() throws {
        let catalog = try ChatTemplateCatalog.parse(
            configData: data(#"{"chat_template":{"default":"CONFIG","tool_use":"TOOL"}}"#),
            chatTemplateData: Data("JINJA".utf8)
        )

        XCTAssertEqual(catalog.entries.map(\.source), [.jinjaFile, .tokenizerConfig, .tokenizerConfig])
        XCTAssertEqual(catalog.entries.map(\.id), [
            "jinjaFile:default", "tokenizerConfig:default", "tokenizerConfig:tool_use"
        ])
        XCTAssertEqual(catalog.activeEntry?.source, .jinjaFile)
        XCTAssertEqual(catalog.activeEntry?.body, "JINJA")
        XCTAssertTrue(catalog.conflict)
    }

    func testEmptyDefaultFallsBackToNonEmptyNamedTemplate() throws {
        let catalog = try ChatTemplateCatalog.parse(
            configData: data(#"{"chat_template":{"default":" ","tool_use":"TOOL"}}"#),
            chatTemplateData: nil
        )

        XCTAssertEqual(catalog.activeEntry?.id, "tokenizerConfig:tool_use")
        XCTAssertTrue(catalog.isAvailable)
        XCTAssertFalse(catalog.conflict)
    }

    func testEmptySourcesMakeChatUnavailable() throws {
        let catalog = try ChatTemplateCatalog.parse(
            configData: data(#"{"chat_template":{"default":"\n"}}"#),
            chatTemplateData: nil
        )

        XCTAssertNil(catalog.activeEntry)
        XCTAssertFalse(catalog.isAvailable)
        XCTAssertFalse(catalog.conflict)
    }

    private func data(_ source: String) -> Data {
        Data(source.utf8)
    }
}
