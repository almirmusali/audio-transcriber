import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    // Фоновая загрузка закончилась, пока приложение было выгружено: система будит его,
    // ждёт, пока сессия раздаст события, и только потом снова усыпляет.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == Uploader.identifier else { return completionHandler() }
        Uploader.shared.backgroundCompletion = completionHandler
        _ = Library.shared
    }
}

@main
struct TranscriberApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var library = Library.shared
    @State private var recorder = Recorder()
    @State private var settings = Settings.shared

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environment(library)
                .environment(recorder)
                .environment(settings)
                .onOpenURL { url in
                    if url.isFileURL { library.importFile(url) }
                }
        }
    }
}
