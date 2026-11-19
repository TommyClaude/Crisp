import SwiftUI

/// What to check by hand: where cameras hide, a few quick tests, and what to
/// do if one turns up. Three short pages, so nothing sits below a scroll.
struct GuideView: View {
    enum Page: String, CaseIterable, Identifiable {
        case places, checks, found

        var id: String { rawValue }

        var title: LocalizedStringKey {
            switch self {
            case .places: "Where"
            case .checks: "Checks"
            case .found: "If found"
            }
        }
    }

    @State var page: Page = .places
    @Environment(\.dismiss) private var dismiss

    private static let places: [(symbol: String, name: LocalizedStringKey)] = [
        ("sensor.fill", "Smoke alarm"),
        ("alarm.fill", "Clock"),
        ("powerplug.fill", "Charger"),
        ("air.conditioner.horizontal.fill", "Vent"),
        ("photo.artframe", "Frame"),
        ("tv.fill", "TV box"),
        ("oval.portrait.fill", "Mirror"),
        ("lamp.desk.fill", "Lamp"),
    ]

    private static let checks: [(symbol: String, text: LocalizedStringKey)] = [
        ("flashlight.on.fill", "Shine a light around the room. A lens glints back."),
        ("hand.point.up.left.fill", "Touch a mirror. No gap between your finger and its reflection is a warning sign."),
        ("powerplug.fill", "Unplug what you don't need, and feel for devices that are warm."),
        ("av.remote.fill", "Aim a TV remote at the infrared check. If its tip flashes on screen, the check works."),
    ]

    private static let steps: [LocalizedStringKey] = [
        "Don't touch or unplug it.",
        "Cover it, then take photos.",
        "Ask for another room.",
        "Report it to the police.",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Check by hand")
                .font(.title.bold())
                .padding(.top, 28)
                .accessibilityAddTraits(.isHeader)

            Picker("Section", selection: $page) {
                ForEach(Page.allCases) { page in
                    Text(page.title).tag(page)
                }
            }
            .pickerStyle(.segmented)

            ViewThatFits(in: .vertical) {
                content.frame(maxHeight: .infinity, alignment: .top)
                ScrollView { content }
            }

            Text("No app can find every camera. Trust your eyes too.")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
            Button("Done") { dismiss() }
                .buttonStyle(CapsuleButtonStyle())
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 16)
        .foregroundStyle(Theme.text)
        .background(Theme.surface.ignoresSafeArea())
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder private var content: some View {
        switch page {
        case .places:
            VStack(alignment: .leading, spacing: 20) {
                Text("Start with what faces the bed.")
                    .foregroundStyle(Theme.secondary)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 20) {
                    ForEach(Self.places, id: \.symbol) { place in
                        VStack(spacing: 8) {
                            Halo(size: 56) { Image(systemName: place.symbol) }
                            Text(place.name)
                                .font(.caption)
                                .foregroundStyle(Theme.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        case .checks:
            VStack(alignment: .leading, spacing: 20) {
                ForEach(Self.checks, id: \.symbol) { check in
                    HStack(spacing: 16) {
                        Halo(size: 44) { Image(systemName: check.symbol) }
                            .accessibilityHidden(true)
                        Text(check.text)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case .found:
            VStack(alignment: .leading, spacing: 20) {
                ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, step in
                    HStack(spacing: 16) {
                        Halo(size: 44) { Text("\(index + 1)") }
                            .accessibilityHidden(true)
                        Text(step)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
}

#Preview {
    GuideView()
        .preferredColorScheme(.dark)
}
