import XCTest
@testable import ModelFiles

final class TemplateRendererTests: XCTestCase {
    func testRendersChatToolsAndTypedVariables() {
        let request = TemplateRenderRequest(
            template: """
            {%- for message in messages %}{{ message.role }}={{ message.content }};{%- endfor %}
            {{- tools | tojson }};thinking={{ enable_thinking }}
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
}
