import AppKit
import SwiftUI

@main
struct ModelFilesApp: App {
    @NSApplicationDelegateAdaptor(ModelFilesAppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1_440, height: 1_024)
        .windowStyle(.hiddenTitleBar)
    }
}

final class ModelFilesAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}
