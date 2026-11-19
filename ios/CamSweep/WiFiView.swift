import SwiftUI

struct WiFiView: View {
    @ObservedObject var scanner: WiFiScanner
    @State private var showHelp = false
    @State private var showGuide = false

    var body: some View {
        Group {
            switch scanner.phase {
            case .idle:
                Stage {
                    RingGauge { ringSymbol("wifi") }
                    StatusBlock(title: "Scan this Wi-Fi", detail: "Looks for devices that stream video.")
                } actions: {
                    Button("Start scan") { scanner.start() }
                        .buttonStyle(CapsuleButtonStyle(isPrimary: true))
                }
            case .asking:
                Stage {
                    RingGauge { ringSymbol("wifi") }
                    StatusBlock(title: "Getting ready", detail: "If iOS asks, allow access to the local network.")
                } actions: {
                    Button("Cancel") { scanner.cancel() }
                        .buttonStyle(CapsuleButtonStyle())
                }
            case .scanning:
                Stage {
                    RingGauge(fraction: scanner.progress) {
                        Text("\(Int(scanner.progress * 100))%")
                            .font(.system(size: 64, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                    }
                    .accessibilityLabel("Scan progress")
                    .accessibilityValue("\(Int(scanner.progress * 100)) percent")
                    StatusBlock(title: "Scanning this Wi-Fi", detail: scanningDetail)
                } actions: {
                    Button("Cancel") { scanner.cancel() }
                        .buttonStyle(CapsuleButtonStyle())
                }
            case .finished:
                results
            case .denied:
                Stage {
                    Halo(size: 72, isLead: false) { Image(systemName: "lock") }
                    StatusBlock(title: "Local network is off",
                                detail: "Allow Local Network for CamSweep in Settings, then scan again.")
                } actions: {
                    Button("Open Settings") { openAppSettings() }
                        .buttonStyle(CapsuleButtonStyle(isPrimary: true))
                    Button("Try again") { scanner.start() }
                        .buttonStyle(CapsuleButtonStyle())
                }
            case .noWiFi:
                Stage {
                    Halo(size: 72, isLead: false) { Image(systemName: "wifi.slash") }
                    StatusBlock(title: "Not on Wi-Fi", detail: "Join the room's Wi-Fi, then scan.")
                } actions: {
                    Button("Try again") { scanner.start() }
                        .buttonStyle(CapsuleButtonStyle(isPrimary: true))
                }
            }
        }
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
            HelpSheet(title: "Scan the Wi-Fi",
                      steps: ["Join the room's Wi-Fi.",
                              "Tap Start scan and wait about a minute.",
                              "Open anything it finds to see what it is."],
                      tip: "Only devices on this Wi-Fi show up. Hotels often hide guests from each other, and some cameras never join Wi-Fi.")
        }
        .sheet(isPresented: $showGuide) {
            GuideView(page: .found)
        }
    }

    private func ringSymbol(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 56, weight: .medium))
            .foregroundStyle(Theme.secondary)
    }

    private var scanningDetail: LocalizedStringKey {
        if !scanner.findings.isEmpty {
            return scanner.findings.count == 1 ? "1 device so far" : "\(scanner.findings.count) devices so far"
        }
        return scanner.sweepsWholeNetwork ? "Checking each address." : "Checking the addresses nearest yours."
    }

    private var results: some View {
        ScrollView {
            VStack(spacing: 20) {
                Halo(size: 72, isLead: scanner.foundLikelyCamera) {
                    Image(systemName: scanner.foundLikelyCamera ? "video.fill" : "wifi")
                }
                .padding(.top, 24)
                .accessibilityHidden(true)

                if scanner.foundLikelyCamera {
                    StatusBlock(title: "Possible camera",
                                detail: "A clue, not proof. Look for it in the room.",
                                isLead: true)
                } else if scanner.findings.isEmpty {
                    StatusBlock(title: "Nothing answered",
                                detail: "That isn't proof. Some cameras never join Wi-Fi.")
                } else {
                    StatusBlock(title: "No camera spotted",
                                detail: "Open a device to see what it is, and check the room by hand too.")
                }

                VStack(spacing: 12) {
                    ForEach(scanner.findings) { finding in
                        FindingRow(finding: finding)
                    }
                }

                if scanner.foundLikelyCamera {
                    Button {
                        showGuide = true
                    } label: {
                        HStack(spacing: 6) {
                            Text("What to do now")
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.bold))
                        }
                        .font(.headline)
                        .foregroundStyle(Theme.accent)
                        .frame(minHeight: 44)
                    }
                }

                Text(scanner.sweepsWholeNetwork
                     ? "Only devices on this Wi-Fi show up."
                     : "This network is large: only the addresses nearest yours were checked.")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 16)
        }
        .safeAreaInset(edge: .bottom) {
            Button {
                scanner.start()
            } label: {
                Label("Scan again", systemImage: "arrow.counterclockwise")
            }
            .buttonStyle(CapsuleButtonStyle())
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(Theme.background)
        }
        .background(Theme.background.ignoresSafeArea())
    }
}

private struct FindingRow: View {
    let finding: Finding

    var body: some View {
        if let url = finding.url {
            Link(destination: url) { row(opens: true) }
                .accessibilityHint("Opens its web page")
        } else {
            row(opens: false)
        }
    }

    private var reason: String {
        finding.isLikelyCamera ? "Streams video" : "Web page only"
    }

    private func row(opens: Bool) -> some View {
        HStack(spacing: 14) {
            Halo(size: 48, isLead: finding.isLikelyCamera) {
                Image(systemName: finding.isLikelyCamera ? "video.fill" : "globe")
            }
            // What it is comes first; the address is the quietest thing here.
            VStack(alignment: .leading, spacing: 2) {
                Text(finding.isLikelyCamera ? "Likely camera" : "Unknown device")
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                ViewThatFits(in: .horizontal) {
                    Text("\(reason) · \(finding.name)")
                        .lineLimit(1)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(reason)
                        Text(finding.name)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .font(.footnote.monospacedDigit())
                .foregroundStyle(Theme.secondary)
            }
            .multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            if opens {
                Text("Open")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(finding.isLikelyCamera ? Theme.onAccent : Theme.text)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 34)
                    .background(finding.isLikelyCamera ? Theme.accent : Theme.raised, in: Capsule())
            }
        }
        .padding(14)
        .card()
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    NavigationStack { WiFiView(scanner: WiFiScanner()) }
        .preferredColorScheme(.dark)
}
