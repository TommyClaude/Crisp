import SwiftUI

@main
struct CamSweepApp: App {
    var body: some Scene {
        WindowGroup {
            HomeView()
                .preferredColorScheme(.dark)
                // Navigation chrome stays quiet; amber is kept for findings.
                .tint(Theme.text)
                .fontDesign(.rounded)
        }
    }
}
