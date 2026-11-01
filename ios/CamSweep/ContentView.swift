import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            IRScanView()
                .tabItem { Label("IR Scan", systemImage: "camera.metering.spot") }
            MagnetometerView()
                .tabItem { Label("Magnet", systemImage: "dot.radiowaves.left.and.right") }
            NetworkScanView()
                .tabItem { Label("Network", systemImage: "wifi") }
            TipsView()
                .tabItem { Label("Tips", systemImage: "lightbulb") }
        }
    }
}

#Preview {
    ContentView()
}
