import AppKit
import SwiftUI
import WebKit

struct ImageReaderView: View {
    let file: RepositoryFile
    let document: ImageDocument
    let perspective: InspectionPerspective

    @State private var zoomScale: Double = 1.0
    @State private var fitToWindow = true

    var body: some View {
        Group {
            if perspective == .source, document.isSVG, let sourceText = document.sourceText {
                CodeReaderView(source: sourceText, language: "markup")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                imageWorkspace
            }
        }
    }

    @ViewBuilder
    private var imageWorkspace: some View {
        VStack(spacing: 0) {
            imageToolbar
            Divider()
            GeometryReader { geometry in
                ScrollView([.horizontal, .vertical]) {
                    ZStack {
                        checkerboardBackground
                        imageView(viewportSize: geometry.size)
                    }
                    .frame(
                        minWidth: geometry.size.width,
                        minHeight: geometry.size.height,
                        alignment: .center
                    )
                }
            }
        }
    }

    private var imageToolbar: some View {
        HStack(spacing: 12) {
            if let nsImage = loadedImage {
                let width = Int(nsImage.size.width)
                let height = Int(nsImage.size.height)
                Text("\(width) × \(height) px")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Text("·")
                    .foregroundStyle(.tertiary)
            }
            Text(file.name.uppercased().split(separator: ".").last.map(String.init) ?? "IMAGE")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("·")
                .foregroundStyle(.tertiary)
            Text(Int64(document.data.count).formattedByteCount)
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer()

            HStack(spacing: 6) {
                Button {
                    fitToWindow = true
                    zoomScale = 1.0
                } label: {
                    Text(String(localized: "适应窗口"))
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .tint(fitToWindow ? .accentColor : nil)

                Button {
                    fitToWindow = false
                    zoomScale = 1.0
                } label: {
                    Text("1:1")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .tint(!fitToWindow && zoomScale == 1.0 ? .accentColor : nil)

                Button {
                    fitToWindow = false
                    zoomScale = max(0.25, zoomScale - 0.25)
                } label: {
                    Image(systemName: "minus.magnifyingglass")
                }
                .buttonStyle(.borderless)
                .help("缩小")

                Text("\(Int(zoomScale * 100))%")
                    .font(.caption.monospacedDigit())
                    .frame(width: 44)

                Button {
                    fitToWindow = false
                    zoomScale = min(5.0, zoomScale + 0.25)
                } label: {
                    Image(systemName: "plus.magnifyingglass")
                }
                .buttonStyle(.borderless)
                .help("放大")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
    }

    @ViewBuilder
    private func imageView(viewportSize: CGSize) -> some View {
        if let nsImage = loadedImage {
            if fitToWindow {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(
                        maxWidth: max(viewportSize.width - 48, 100),
                        maxHeight: max(viewportSize.height - 48, 100)
                    )
                    .padding(24)
            } else {
                let targetWidth = nsImage.size.width * zoomScale
                let targetHeight = nsImage.size.height * zoomScale
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: max(targetWidth, 10), height: max(targetHeight, 10))
                    .padding(24)
            }
        } else if document.isSVG {
            SVGWebView(data: document.data)
                .frame(
                    width: fitToWindow ? max(viewportSize.width - 48, 200) : max(400 * zoomScale, 100),
                    height: fitToWindow ? max(viewportSize.height - 48, 200) : max(400 * zoomScale, 100)
                )
                .padding(24)
        } else {
            EmptyStateView(
                title: String(localized: "无法显示图片"),
                systemImage: "photo.badge.exclamationmark",
                message: String(localized: "系统无法解码此图片格式。")
            )
        }
    }

    private var loadedImage: NSImage? {
        NSImage(data: document.data)
    }

    private var checkerboardBackground: some View {
        Canvas { context, size in
            let tileSize: CGFloat = 16
            let cols = Int(ceil(size.width / tileSize))
            let rows = Int(ceil(size.height / tileSize))
            let lightColor = Color(nsColor: .textBackgroundColor)
            let darkColor = Color(nsColor: .windowBackgroundColor)

            for col in 0..<cols {
                for row in 0..<rows {
                    let isEven = (col + row) % 2 == 0
                    let rect = CGRect(
                        x: CGFloat(col) * tileSize,
                        y: CGFloat(row) * tileSize,
                        width: tileSize,
                        height: tileSize
                    )
                    context.fill(Path(rect), with: .color(isEven ? lightColor : darkColor))
                }
            }
        }
        .allowsHitTesting(false)
    }
}

private struct SVGWebView: NSViewRepresentable {
    let data: Data

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.load(
            data,
            mimeType: "image/svg+xml",
            characterEncodingName: "utf-8",
            baseURL: URL(fileURLWithPath: "/")
        )
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        webView.load(
            data,
            mimeType: "image/svg+xml",
            characterEncodingName: "utf-8",
            baseURL: URL(fileURLWithPath: "/")
        )
    }
}
