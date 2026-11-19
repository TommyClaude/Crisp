import SwiftUI

struct WiFiView: View {
    @StateObject private var scanner = WiFiScanner()
    @State private var showHelp = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            switch scanner.phase {
            case .idle:
                stage(Emblem(symbol: "wifi"),
                     title: "Scan this Wi-Fi",
                     detail: "Looks for devices that stream video.") {
                    Button("Start scan") { scanner.start() }
                        .buttonStyle(PrimaryButtonStyle())
                }
            case .asking:
                stage(Emblem(symbol: "wifi", isActive: true),
                     title: "Waiting for permission",
                     detail: "Allow access to the local network to scan it.") {
                    Button("Stop") { scanner.cancel() }
                        .buttonStyle(SecondaryButtonStyle())
                }
            case .scanning:
                stage(progressRing,
                     title: "Scanning",
                     detail: "Checking every address on this network.") {
                    Button("Stop") { scanner.cancel() }
                        .buttonStyle(SecondaryButtonStyle())
                }
            case .finished:
                results
            case .denied:
                ContentUnavailableView {
                    Label("Local network access is off", systemImage: "lock")
                } description: {
                    Text("Allow Local Network for CamSweep in Settings, then scan again.")
                } actions: {
                    Button("Open Settings") { openAppSettings() }
                        .buttonStyle(.bordered)
                    Button("Try again") { scanner.start() }
                }
            case .noWiFi:
                ContentUnavailableView {
                    Label("Not on Wi-Fi", systemImage: "wifi.slash")
                } description: {
                    Text("Join the room's Wi-Fi, then scan.")
                } actions: {
                    Button("Try again") { scanner.start() }
                        .buttonStyle(.bordered)
                }
            }
        }
        .navigationTitle("Wi-Fi")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showHelp = true
                } label: {
                    Image(systemName: "questionmark.circle")
                }
                .accessibilityLabel("How it works")
            }
        }
        .sheet(isPresented: $showHelp) {
            HelpSheet(title: "Wi-Fi scan", steps: [
                .init(symbol: "wifi", text: "Join the room's Wi-Fi first. The scan only sees devices on the same network."),
                .init(symbol: "video.fill", text: "A device that streams video is very likely a camera."),
                .init(symbol: "globe", text: "A device with only a web page could be a router, a TV or a camera. Open it to see."),
                .init(symbol: "eye.slash", text: "Many hotels hide guests from each other, and some cameras never join Wi-Fi. An empty result is not proof."),
            ])
        }
        .onDisappear { scanner.cancel() }
    }

    /// One centered hero, a headline, and the screen's single action.
    private func stage<Hero: View, Action: View>(_ hero: Hero,
                                                 title: LocalizedStringKey,
                                                 detail: LocalizedStringKey,
                                                 @ViewBuilder action: () -> Action) -> some View {
        VStack(spacing: 32) {
            Spacer()
            hero
            Headline(title: title, detail: detail)
            Spacer()
            action()
        }
        .padding(20)
    }

    private var progressRing: some View {
        ZStack {
            Circle()
                .stroke(Theme.surface, lineWidth: 16)
            Circle()
                .trim(from: 0, to: scanner.progress)
                .stroke(Theme.accent, style: StrokeStyle(lineWidth: 16, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 0.2), value: scanner.progress)
            Text("\(Int(scanner.progress * 100))%")
                .font(.system(size: 56, weight: .bold, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText())
        }
        .frame(width: 216, height: 216)
        .padding(12)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Scan progress")
        .accessibilityValue("\(Int(scanner.progress * 100)) percent")
    }

    private var results: some View {
        ScrollView {
            VStack(spacing: 24) {
                if scanner.foundLikelyCamera {
                    Emblem(symbol: "video.fill", color: Theme.alert)
                    Headline(title: "Possible camera",
                             detail: "A device on this Wi-Fi streams video.",
                             color: Theme.alert)
                } else if scanner.findings.isEmpty {
                    Emblem(symbol: "wifi")
                    Headline(title: "Nothing found",
                             detail: "No device answered. Hidden cameras can still be here, so check by hand too.")
                } else {
                    Emblem(symbol: "wifi")
                    Headline(title: "No video streams",
                             detail: "These devices are on this Wi-Fi. Open one to see what it is.")
                }

                if !scanner.findings.isEmpty {
                    VStack(spacing: 10) {
                        ForEach(scanner.findings) { finding in
                            FindingRow(finding: finding)
                        }
                    }
                }
            }
            .padding(20)
        }
        .safeAreaInset(edge: .bottom) {
            Button("Scan again") { scanner.start() }
                .buttonStyle(SecondaryButtonStyle())
                .padding(20)
                .background(Theme.background)
        }
    }
}

private struct FindingRow: View {
    let finding: Finding

    var body: some View {
        if let url = finding.url {
            Link(destination: url) { row(opens: true) }
        } else {
            row(opens: false)
        }
    }

    private func row(opens: Bool) -> some View {
        HStack(spacing: 14) {
            Image(systemName: finding.isLikelyCamera ? "video.fill" : "globe")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(finding.isLikelyCamera ? Theme.alert : Theme.dim)
                .frame(width: 44, height: 44)
                .background((finding.isLikelyCamera ? Theme.alert : Color.white).opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(finding.name)
                    .font(.body.monospacedDigit().weight(.medium))
                    .foregroundStyle(.white)
                Text(finding.isLikelyCamera ? "Streams video" : "Has a web page")
                    .font(.footnote)
                    .foregroundStyle(Theme.dim)
            }
            Spacer(minLength: 8)
            if opens {
                Image(systemName: "arrow.up.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.dim)
            }
        }
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    NavigationStack { WiFiView() }
        .preferredColorScheme(.dark)
}
