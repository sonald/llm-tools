import Foundation
import PDFKit
import SwiftUI

struct PDFReaderView: NSViewRepresentable {
    let data: Data

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayDirection = .vertical
        view.displayMode = .singlePageContinuous
        view.setAccessibilityLabel(String(localized: "PDF 文档"))
        view.document = PDFDocument(data: data)
        context.coordinator.data = data
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        guard context.coordinator.data != data else { return }
        context.coordinator.data = data
        view.document = PDFDocument(data: data)
    }

    final class Coordinator {
        var data: Data?
    }
}
