import SwiftUI

/// The three checks, in the order worth doing them.
enum Check: String, CaseIterable, Identifiable {
    case wifi, infrared, magnetic

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .wifi: "wifi"
        case .infrared: "camera.metering.spot"
        case .magnetic: "dot.radiowaves.left.and.right"
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .wifi: "Scan the Wi-Fi"
        case .infrared: "Look for infrared"
        case .magnetic: "Sweep for electronics"
        }
    }

    var detail: LocalizedStringKey {
        switch self {
        case .wifi: "Finds cameras on the network"
        case .infrared: "Spots night-vision lights in the dark"
        case .magnetic: "Senses hidden devices up close"
        }
    }
}

struct HomeView: View {
    @State private var path: [Check] = Demo.screen.flatMap(Check.init(rawValue:)).map { [$0] } ?? []
    @State private var showGuide = Demo.screen == "guide"

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("CamSweep")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.accent)
                        Text("Check your room")
                            .font(.largeTitle.bold())
                        Text("Three quick checks for hidden cameras.")
                            .foregroundStyle(Theme.dim)
                    }
                    .padding(.top, 32)
                    .padding(.bottom, 20)

                    ForEach(Array(Check.allCases.enumerated()), id: \.element) { index, check in
                        NavigationLink(value: check) {
                            CheckCard(check: check, number: index + 1)
                        }
                        .buttonStyle(.plain)
                    }

                    Button {
                        showGuide = true
                    } label: {
                        HStack {
                            Label("What to look for by hand", systemImage: "eye")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.dim)
                        }
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 20)
                        .frame(minHeight: 56)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    Text("No app can find every camera. Trust your eyes too.")
                        .font(.footnote)
                        .foregroundStyle(Theme.dim)
                        .padding(.horizontal, 20)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .background(Theme.background.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Check.self) { check in
                switch check {
                case .wifi: WiFiView()
                case .infrared: InfraredView()
                case .magnetic: MagneticView()
                }
            }
            .sheet(isPresented: $showGuide) {
                GuideView()
            }
        }
    }
}

private struct CheckCard: View {
    let check: Check
    let number: Int

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: check.symbol)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .frame(width: 56, height: 56)
                .background(Theme.accent.opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(check.title)
                    .font(.headline)
                Text(check.detail)
                    .font(.subheadline)
                    .foregroundStyle(Theme.dim)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.dim)
        }
        .padding(20)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityHint("Step \(number) of 3")
    }
}

#Preview {
    HomeView()
        .preferredColorScheme(.dark)
}
