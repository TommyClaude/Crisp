import SwiftUI

@main
struct CamSweepApp: App {
    var body: some Scene {
        WindowGroup {
            HomeView()
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
                .fontDesign(.rounded)
        }
    }
}
