import Foundation
import XCTest
@testable import ModelFiles

final class ConsistencyAnalyzerTests: XCTestCase {
    func testBuildsIdentityFieldsAndReportsOnlyRealVocabMismatch() throws {
        let config = try json([
            "architectures": ["QwenForCausalLM"],
            "num_hidden_layers": 32,
            "hidden_size": 4_096,
            "vocab_size": 100,
            "max_position_embeddings": 8_192,
            "num_experts": 64,
            "num_experts_per_tok": 8,
        ])
        let adapter = try json([
            "peft_type": "LORA",
            "base_model_name_or_path": "Qwen/Base",
        ])
        let processor = try json(["image_size": 448])

        let mismatch = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(config),
            tokenizer: .available(tokenizer(vocabCount: 99)),
            adapterConfig: .available(adapter),
            processorConfig: .available(processor)
        ))

        XCTAssertEqual(mismatch.identityFields.map(\.key), [
            "architecture", "layers", "hidden_size", "vocab_size", "context",
            "num_experts", "num_experts_per_tok", "peft_type", "base_model_name_or_path",
            "image_size",
        ])
        XCTAssertTrue(mismatch.identityFields.allSatisfy { $0.origin == .embedded })
        let finding = try XCTUnwrap(mismatch.findings.first { $0.id == "vocab-mismatch" })
        XCTAssertEqual(finding.severity, .warning)
        XCTAssertEqual(finding.left.value, "100")
        XCTAssertEqual(finding.right.value, "99")
        XCTAssertEqual(finding.right.origin, .derived)

        let matching = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(config),
            tokenizer: .available(tokenizer(vocabCount: 100))
        ))
        XCTAssertFalse(matching.findings.contains { $0.id == "vocab-mismatch" })
    }

    func testMissingTokenizerClassHasPositiveAndNegativeCases() throws {
        let missing = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            tokenizerConfig: .available(try json([
                "model_max_length": 4_096,
                "tokenizer_class": "   ",
            ]))
        ))
        let finding = try XCTUnwrap(missing.findings.first { $0.id == "missing-tokenizer-class" })
        XCTAssertEqual(finding.severity, .warning)
        XCTAssertEqual(finding.right.value, "缺失")

        let present = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            tokenizerConfig: .available(try json(["tokenizer_class": "LlamaTokenizer"]))
        ))
        XCTAssertFalse(present.findings.contains { $0.id == "missing-tokenizer-class" })
    }

    func testMissingChatTemplateReusesCatalogAvailability() throws {
        let missing = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            chatTemplates: .available(ChatTemplateCatalog(entries: []))
        ))
        XCTAssertEqual(
            missing.findings.first { $0.id == "missing-chat-template" }?.severity,
            .info
        )

        let available = ChatTemplateCatalog(entries: [
            ChatTemplateEntry(name: "default", source: .jinjaFile, body: "{{ messages }}")
        ])
        let present = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            chatTemplates: .available(available)
        ))
        XCTAssertFalse(present.findings.contains { $0.id == "missing-chat-template" })
    }

    func testEOSMismatchUsesExplicitIDsThenAddedTokenFallbackAndRejectsMalformedValues() throws {
        let explicitMismatch = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            generationConfig: .available(try json(["eos_token_id": 3])),
            tokenizerConfig: .available(try json(["eos_token_id": 2])),
            tokenizer: .available(tokenizer(vocabCount: 10))
        ))
        let explicit = try XCTUnwrap(explicitMismatch.findings.first { $0.id == "eos-mismatch" })
        XCTAssertEqual(explicit.left.value, "3")
        XCTAssertEqual(explicit.right.value, "2")
        XCTAssertEqual(explicit.right.origin, .embedded)

        let sameArrays = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            generationConfig: .available(try json(["eos_token_id": [3, 2]])),
            tokenizerConfig: .available(try json(["eos_token_id": [2, 3]]))
        ))
        XCTAssertFalse(sameArrays.findings.contains { $0.id == "eos-mismatch" })

        let fallbackMismatch = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            generationConfig: .available(try json(["eos_token_id": [2, 3]])),
            tokenizerConfig: .available(try json(["eos_token": ["content": "</s>"]])),
            tokenizer: .available(tokenizer(
                vocabCount: 10,
                addedTokens: [TokenizerAddedTokenInfo(id: 2, content: "</s>", special: true)]
            ))
        ))
        let fallback = try XCTUnwrap(fallbackMismatch.findings.first { $0.id == "eos-mismatch" })
        XCTAssertEqual(fallback.right.value, "2")
        XCTAssertEqual(fallback.right.origin, .derived)

        let malformed = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            generationConfig: .available(try json(["eos_token_id": [2, "bad"]])),
            tokenizerConfig: .available(try json(["eos_token_id": 2]))
        ))
        XCTAssertFalse(malformed.findings.contains { $0.id == "eos-mismatch" })
    }

    func testContextRulesHavePositiveAndNegativeCases() throws {
        let mismatch = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["max_position_embeddings": 4_096])),
            tokenizerConfig: .available(try json(["model_max_length": 8_192])),
            gguf: .available(gguf(contextLength: 2_048))
        ))
        XCTAssertEqual(mismatch.findings.first { $0.id == "context-info" }?.severity, .info)
        XCTAssertEqual(
            mismatch.findings.first { $0.id == "gguf-context-mismatch" }?.severity,
            .warning
        )

        let matching = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["max_position_embeddings": 4_096])),
            tokenizerConfig: .available(try json(["model_max_length": 4_096])),
            gguf: .available(gguf(contextLength: 4_096))
        ))
        XCTAssertFalse(matching.findings.contains { $0.id == "context-info" })
        XCTAssertFalse(matching.findings.contains { $0.id == "gguf-context-mismatch" })
    }

    func testGGUFVocabUsesOnlyConservativeEmbeddingNamePriority() throws {
        let tokenizerMaterial = ConsistencyMaterial.available(tokenizer(vocabCount: 100))
        let exactWins = gguf(tensors: [
            tensor("aaa.weight", firstDimension: 999),
            tensor("model.embed_tokens.weight", firstDimension: 999),
            tensor("a.token_embd.weight", firstDimension: 999),
            tensor("token_embd.weight", firstDimension: 100),
        ])
        let exactReport = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            tokenizer: tokenizerMaterial,
            gguf: .available(exactWins)
        ))
        XCTAssertFalse(exactReport.findings.contains { $0.id == "gguf-vocab-mismatch" })

        let wildcardWins = gguf(tensors: [
            tensor("z.token_embd.weight", firstDimension: 101),
            tensor("a.token_embd.weight", firstDimension: 99),
            tensor("model.embed_tokens.weight", firstDimension: 100),
        ])
        let wildcardReport = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            tokenizer: tokenizerMaterial,
            gguf: .available(wildcardWins)
        ))
        let wildcard = try XCTUnwrap(
            wildcardReport.findings.first { $0.id == "gguf-vocab-mismatch" }
        )
        XCTAssertEqual(wildcard.left.key, "GGUF a.token_embd.weight[0]")
        XCTAssertEqual(wildcard.left.value, "99")
        XCTAssertEqual(wildcard.left.origin, .embedded)

        let modelEmbedding = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            tokenizer: tokenizerMaterial,
            gguf: .available(gguf(tensors: [
                tensor("model.embed_tokens.weight", firstDimension: 101)
            ]))
        ))
        XCTAssertEqual(
            modelEmbedding.findings.first { $0.id == "gguf-vocab-mismatch" }?.left.key,
            "GGUF model.embed_tokens.weight[0]"
        )

        let emptyShape = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            tokenizer: tokenizerMaterial,
            gguf: .available(gguf(tensors: [tensorWithoutDimensions("token_embd.weight")]))
        ))
        XCTAssertFalse(emptyShape.findings.contains { $0.id == "gguf-vocab-mismatch" })

        let unknown = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"])),
            tokenizer: tokenizerMaterial,
            gguf: .available(gguf(tensors: [tensor("first.weight", firstDimension: 999)]))
        ))
        XCTAssertFalse(unknown.findings.contains { $0.id == "gguf-vocab-mismatch" })
    }

    func testMissingConfigAndCoverageDistinguishMissingFailedAndChecked() throws {
        let report = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            generationConfig: .failed("permission denied"),
            tokenizer: .available(tokenizer(vocabCount: 100)),
            adapterConfig: .available(Data("{".utf8)),
            gguf: .skipped("未在当前会话打开")
        ))

        XCTAssertEqual(report.findings.filter { $0.id == "missing-config" }.count, 1)
        XCTAssertEqual(report.findings.first { $0.id == "missing-config" }?.severity, .info)
        XCTAssertEqual(status(.config, in: report), .missing)
        XCTAssertEqual(status(.generationConfig, in: report), .failed("permission denied"))
        guard case let .failed(adapterError) = status(.adapterConfig, in: report) else {
            return XCTFail("Malformed available JSON must become failed coverage.")
        }
        XCTAssertFalse(adapterError.isEmpty)
        XCTAssertEqual(status(.tokenizer, in: report), .checked)
        XCTAssertEqual(status(.gguf, in: report), .skipped("未在当前会话打开"))
        XCTAssertFalse(report.findings.contains { $0.id == "vocab-mismatch" })

        let availableConfig = ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: .available(try json(["model_type": "llama"]))
        ))
        XCTAssertFalse(availableConfig.findings.contains { $0.id == "missing-config" })
    }

    private func status(
        _ material: ConsistencyMaterialKind,
        in report: RepositoryConsistencyReport
    ) -> ConsistencyCoverageStatus? {
        report.coverage.first { $0.material == material }?.status
    }

    private func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func tokenizer(
        vocabCount: Int?,
        addedTokens: [TokenizerAddedTokenInfo] = []
    ) -> TokenizerOverview {
        TokenizerOverview(
            version: "1.0",
            modelType: "BPE",
            vocabCount: vocabCount,
            mergeCount: nil,
            addedTokenCount: addedTokens.count,
            addedTokens: addedTokens,
            vocabularyAnalysis: nil,
            fields: []
        )
    }

    private func gguf(
        contextLength: UInt64? = nil,
        tensors: [TensorDescriptor] = []
    ) -> GGUFOverview {
        let metadata = contextLength.map {
            [GGUFMetadataEntry(
                key: "llama.context_length",
                type: "uint32",
                value: String($0),
                stringValue: nil,
                unsignedValue: $0
            )]
        } ?? []
        return GGUFOverview(
            version: 3,
            isLittleEndian: true,
            metadata: metadata,
            tensors: tensors,
            parameterCount: 0,
            tensorDataOffset: 0,
            alignment: 32
        )
    }

    private func tensor(_ name: String, firstDimension: UInt64) -> TensorDescriptor {
        TensorDescriptor(
            name: name,
            dataType: "F16",
            shape: [firstDimension, 8],
            parameterCount: firstDimension * 8,
            byteCount: nil,
            offset: nil
        )
    }

    private func tensorWithoutDimensions(_ name: String) -> TensorDescriptor {
        TensorDescriptor(
            name: name,
            dataType: "F16",
            shape: [],
            parameterCount: 0,
            byteCount: nil,
            offset: nil
        )
    }
}
