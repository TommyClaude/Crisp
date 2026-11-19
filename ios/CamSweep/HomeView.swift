import SwiftUI
import UIKit

/// The three checks, in the order worth doing them: the two that work with
/// the lights on first, the one that needs a dark room last.
enum Check: String, CaseIterable, Identifiable {
    case wifi, magnetic, infrared

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .wifi: "wifi"
        case .magnetic: "dot.radiowaves.left.and.right"
        case .infrared: "camera.metering.spot"
        }
    }

    /// Shown on the home card and as the title of the check's own screen.
    var title: LocalizedStringKey {
        switch self {
        case .wifi: "Scan the Wi-Fi"
        case .magnetic: "Sweep for electronics"
        case .infrared: "Look for infrared"
        }
    }

    var detail: LocalizedStringKey {
        switch self {
        case .wifi: "Cameras on this network"
        case .magnetic: "Hidden devices, up close"
        case .infrared: "Night-vision lights"
        }
    }
}

struct HomeView: View {
    // The scan lives here, so it and its result survive leaving its screen.
    @StateObject private var wifi = WiFiScanner()
    @State private var path: [Check] = Demo.screen.flatMap(Check.init(rawValue:)).map { [$0] } ?? []
    @State private var showGuide = Demo.screen == "guide"
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: 12) {
                    Emblem()
                        .padding(.top, 16)
                    Text("Check your room")
                        .font(.largeTitle.bold())
                        .accessibilityAddTraits(.isHeader)
                    Text("Three checks. Do the last one in the dark.")
                        .foregroundStyle(Theme.secondary)
                        .padding(.bottom, 12)

                    ForEach(Check.allCases) { check in
                        NavigationLink(value: check) {
                            CheckCard(check: check, note: check == .wifi ? wifiNote : nil)
                        }
                        .buttonStyle(.plain)
                    }

                    Button {
                        showGuide = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "hand.raised")
                                .foregroundStyle(Theme.secondary)
                            Text("What to check by hand")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.secondary)
                        }
                        .font(.headline)
                        .padding(.horizontal, 20)
                        .frame(minHeight: 60)
                        .card()
                    }
                    .buttonStyle(.plain)

                    Text("No app can find every camera. Trust your eyes too.")
                        .font(.footnote)
                        .foregroundStyle(Theme.secondary)
                        .padding(.top, 8)
                }
                .multilineTextAlignment(.center)
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .foregroundStyle(Theme.text)
            .background(Theme.background.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Check.self) { check in
                Group {
                    switch check {
                    case .wifi: WiFiView(scanner: wifi)
                    case .magnetic: MagneticView()
                    case .infrared: InfraredView()
                    }
                }
                .foregroundStyle(Theme.text)
                .navigationTitle(check.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarRole(.editor)
            }
            .sheet(isPresented: $showGuide) {
                GuideView()
            }
        }
        // A locked screen suspends a scan and hides a sweep, so stay awake
        // while a check is doing something.
        .onChange(of: staysAwake, initial: true) { _, awake in
            UIApplication.shared.isIdleTimerDisabled = awake
        }
        .onChange(of: scenePhase) { _, phase in
            // A suspended sweep would come back with holes in it.
            if phase == .background && wifi.phase == .scanning { wifi.cancel() }
        }
        .onChange(of: wifi.phase) { _, phase in
            // Here rather than on the Wi-Fi screen, because the scan may
            // finish after the person has left that screen.
            switch phase {
            case .finished:
                announce(wifi.foundLikelyCamera ? "Wi-Fi scan finished. Possible camera." : "Wi-Fi scan finished. No camera spotted.")
            case .denied:
                announce("Local network is off.")
            case .noWiFi:
                announce("Not on Wi-Fi.")
            default:
                break
            }
        }
    }

    private var staysAwake: Bool {
        wifi.isBusy || path.last == .magnetic || path.last == .infrared
    }

    /// What the Wi-Fi card says while a scan runs, or once it found something.
    private var wifiNote: LocalizedStringKey? {
        if wifi.isBusy { return "Scanning… \(Int(wifi.progress * 100))%" }
        if wifi.phase == .finished && wifi.foundLikelyCamera { return "Possible camera found" }
        return nil
    }
}

/// The home screen's hero: the halo motif at full size, around one warm light.
private struct Emblem: View {
    var body: some View {
        ZStack {
            ForEach([120.0, 88.0, 56.0], id: \.self) { diameter in
                Circle()
                    .strokeBorder(Theme.text.opacity(diameter == 56 ? 0.16 : 0.08), lineWidth: 1)
                    .frame(width: diameter, height: diameter)
            }
            Circle()
                .fill(Theme.accent)
                .frame(width: 12, height: 12)
                .shadow(color: Theme.accent.opacity(0.8), radius: 12)
        }
        .frame(width: 120, height: 120)
        .accessibilityHidden(true)
    }
}

private struct CheckCard: View {
    let check: Check
    /// Replaces the description with live news about this check.
    var note: LocalizedStringKey?

    var body: some View {
        HStack(spacing: 16) {
            Halo(size: 56) { Image(systemName: check.symbol) }
            VStack(alignment: .leading, spacing: 4) {
                Text(check.title)
                    .font(.headline.bold())
                Text(note ?? check.detail)
                    .font(.subheadline)
                    .foregroundStyle(note == nil ? Theme.secondary : Theme.accent)
            }
            .multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.secondary)
        }
        .padding(20)
        .frame(minHeight: 104)
        .card()
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    HomeView()
        .preferredColorScheme(.dark)
}
