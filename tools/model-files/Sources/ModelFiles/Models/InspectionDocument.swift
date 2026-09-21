import Foundation

enum StructuredInspectionFormat: Sendable, Equatable {
    case safetensors
    case gguf
    case imatrix
    case jinja
    case pdf
    case image

    var title: String {
        switch self {
        case .safetensors: "SafeTensors"
        case .gguf: "GGUF"
        case .imatrix: "Imatrix"
        case .jinja: "Jinja"
        case .pdf: "PDF"
        case .image: "Image"
        }
    }

    var loadingDescription: String {
        switch self {
        case .safetensors: String(localized: "正在读取 SafeTensors Header…")
        case .gguf: String(localized: "正在读取 GGUF metadata 前缀…")
        case .imatrix: String(localized: "正在读取 Imatrix 数据…")
        case .jinja: String(localized: "正在读取 Jinja 源码…")
        case .pdf: String(localized: "正在读取 PDF 文档…")
        case .image: String(localized: "正在读取图片…")
        }
    }
}

enum InspectionPerspective: String, Identifiable, Sendable {
    case overview
    case metadata
    case tensors
    case entries
    case source
    case playground
    case fields
    case raw

    var id: Self { self }

    var title: String {
        switch self {
        case .overview: String(localized: "概览")
        case .metadata: "Metadata"
        case .tensors: "Tensors"
        case .entries: "Entries"
        case .source: String(localized: "源码")
        case .playground: String(localized: "试验台")
        case .fields: String(localized: "全部字段")
        case .raw: String(localized: "原文")
        }
    }
}

struct InspectionField: Identifiable, Sendable, Equatable {
    enum Origin: String, Sendable {
        case embedded
        case derived
        case repository
        case runtime

        var title: String {
            switch self {
            case .embedded: String(localized: "文件内嵌")
            case .derived: String(localized: "应用推导")
            case .repository: String(localized: "来源信息")
            case .runtime: String(localized: "运行结果")
            }
        }
    }

    let key: String
    let type: String
    let value: String
    let origin: Origin

    var id: String { key }
}

struct TensorDescriptor: Identifiable, Sendable, Equatable {
    let name: String
    let dataType: String
    let shape: [UInt64]
    let parameterCount: UInt64
    let byteCount: UInt64?
    let offset: UInt64?

    var id: String { name }

    var shapeText: String {
        "[" + shape.map(String.init).joined(separator: ", ") + "]"
    }
}

struct JinjaDocument: Sendable, Equatable {
    let source: String
}

struct ImageDocument: Sendable, Equatable {
    let data: Data
    let isSVG: Bool
    let sourceText: String?
}

enum InspectionDocument: Sendable {
    case safetensors(SafetensorsOverview, headerByteCount: Int)
    case gguf(GGUFOverview, downloadedByteCount: Int)
    case imatrix(IMatrixOverview)
    case jinja(JinjaDocument)
    case pdf(Data)
    case image(ImageDocument)
    case generic(Data)

    var perspectives: [InspectionPerspective] {
        switch self {
        case .safetensors, .gguf:
            [.overview, .metadata, .tensors]
        case .imatrix:
            [.overview, .entries]
        case .jinja:
            [.overview, .source, .playground]
        case .pdf:
            [.overview]
        case let .image(document):
            document.isSVG ? [.overview, .source] : [.overview]
        case .generic:
            [.overview, .fields, .raw]
        }
    }

    var formatTitle: String? {
        switch self {
        case .safetensors: "SafeTensors"
        case let .gguf(overview, _): overview.isIMatrix ? "GGUF Imatrix" : "GGUF v\(overview.version)"
        case .imatrix: "Imatrix DAT"
        case .jinja: "Jinja"
        case .pdf: "PDF"
        case let .image(document): document.isSVG ? "SVG" : "Image"
        case .generic: nil
        }
    }

    var safetyNotice: String? {
        switch self {
        case let .safetensors(_, byteCount):
            String(localized: "只读取了 \(Int64(byteCount).formattedByteCount) JSON Header；没有请求 tensor 数据。")
        case let .gguf(_, byteCount):
            String(localized: "只读取了 \(Int64(byteCount).formattedByteCount) GGUF 文件前缀；最后一个 Range 可能包含少量首个 tensor 数据。")
        case let .imatrix(overview):
            String(localized: "读取了完整的 \(Int64(overview.byteCount).formattedByteCount) legacy imatrix 文件；只解析，不执行。")
        case let .pdf(data):
            String(localized: "读取了完整的 \(Int64(data.count).formattedByteCount) PDF，使用系统 PDFKit 本地预览。")
        case let .image(document):
            String(localized: "读取了完整的 \(Int64(document.data.count).formattedByteCount) 图片数据，在本地直接渲染。")
        case .jinja, .generic:
            nil
        }
    }
}

extension RepositoryFile {
    var isSentencePieceModel: Bool {
        name.lowercased().hasSuffix(".model")
    }

    var isTokenizerPlaygroundEntryPoint: Bool {
        name.lowercased() == "tokenizer.json" || isSentencePieceModel
    }

    var isImage: Bool {
        FileClassifier.isImageFileName(name)
    }

    var structuredInspectionFormat: StructuredInspectionFormat? {
        let lowercasedName = name.lowercased()
        if lowercasedName.hasSuffix(".safetensors") { return .safetensors }
        if FileClassifier.isGGUFFileName(lowercasedName) { return .gguf }
        if lowercasedName.contains("imatrix"),
           lowercasedName.hasSuffix(".dat") || lowercasedName.contains(".dat.at_") {
            return .imatrix
        }
        if lowercasedName.hasSuffix(".pdf") { return .pdf }
        if FileClassifier.isImageFileName(lowercasedName) { return .image }
        if FileClassifier.syntaxLanguage(for: lowercasedName) != nil { return nil }
        if category == .templates { return .jinja }
        return nil
    }
}
