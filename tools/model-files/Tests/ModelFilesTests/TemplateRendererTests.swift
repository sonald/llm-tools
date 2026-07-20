import XCTest
@testable import ModelFiles

final class TemplateRendererTests: XCTestCase {
    func testRendersChatToolsAndTypedVariables() {
        let request = TemplateRenderRequest(
            template: """
            {%- for message in messages %}{{ message.role }}={{ message.content }};{%- endfor %}
            {{- tools | tojson(sort_keys=true, separators=(",", ":")) }};thinking={{ enable_thinking }}
            """,
            messages: [TemplateMessage(role: "user", content: "hello")],
            includeTools: true,
            tools: [
                TemplateTool(
                    name: "search",
                    description: "Search",
                    parametersJSON: #"{"type":"object","properties":{"query":{"type":"string"}}}"#
                )
            ],
            variables: [
                TemplateVariable(name: "enable_thinking", kind: .boolean, value: "false")
            ],
            addGenerationPrompt: true
        )

        let result = TemplateRenderer.render(request)

        XCTAssertNil(result.error)
        XCTAssertTrue(result.output.contains("user=hello"))
        XCTAssertTrue(result.output.contains(#""name":"search""#))
        XCTAssertTrue(result.output.contains("thinking=false"))
    }

    func testRenderedOutputStructureOnlyReferencesExactSourceRanges() throws {
        let source = """
        <|message_system|>tool_declare<|content_xml|>[{"name":"get_weather"}]<|end_message|><|message_user|><|content_text|>  Hello!\n<|end_message|><|message_model|>
        """

        let items = RenderedOutputInspector.items(in: source)
        let xml = try XCTUnwrap(items.first { $0.title == "content_xml" })
        let text = try XCTUnwrap(items.first { $0.title == "content_text" })

        XCTAssertEqual(
            (source as NSString).substring(with: xml.range),
            #"<|content_xml|>[{"name":"get_weather"}]"#
        )
        XCTAssertEqual(
            (source as NSString).substring(with: text.range),
            "<|content_text|>  Hello!\n"
        )
        XCTAssertTrue(try XCTUnwrap(RenderedOutputInspector.prettyPrintedJSON(for: xml, in: source))
            .contains("\n"))
    }
}
