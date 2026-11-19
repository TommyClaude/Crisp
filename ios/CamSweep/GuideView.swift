import SwiftUI

/// What to check by hand: where cameras hide, quick tests, and what to do
/// if one turns up.
struct GuideView: View {
    @Environment(\.dismiss) private var dismiss

    private struct Item: Identifiable {
        let id = UUID()
        let symbol: String
        let text: LocalizedStringKey
    }

    private let places = [
        Item(symbol: "sensor.fill", text: "Smoke detectors"),
        Item(symbol: "alarm.fill", text: "Clocks"),
        Item(symbol: "powerplug.fill", text: "Chargers"),
        Item(symbol: "air.conditioner.horizontal.fill", text: "Vents"),
        Item(symbol: "photo.artframe", text: "Frames"),
        Item(symbol: "tv.fill", text: "TV boxes"),
    ]

    private let checks = [
        Item(symbol: "flashlight.on.fill", text: "Shine a light around the room. A lens glints back."),
        Item(symbol: "hand.point.up.left.fill", text: "Touch a mirror. No gap between your finger and its reflection is a warning sign."),
        Item(symbol: "powerplug.fill", text: "Unplug devices you don't need, and feel for ones that are warm."),
    ]

    private let actions = [
        Item(symbol: "hand.raised.fill", text: "Don't touch or unplug it."),
        Item(symbol: "camera.fill", text: "Cover it, then take photos."),
        Item(symbol: "phone.fill", text: "Ask for another room and call the police."),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("What to look for")
                    .font(.title.bold())
                    .padding(.top, 32)

                sectionTitle("Where cameras hide")
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                    ForEach(places) { place in
                        VStack(spacing: 10) {
                            Image(systemName: place.symbol)
                                .font(.system(size: 24, weight: .semibold))
                                .foregroundStyle(Theme.accent)
                                .frame(height: 30)
                            Text(place.text)
                                .font(.footnote.weight(.medium))
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity, minHeight: 96)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                }

                sectionTitle("Quick checks")
                rows(checks, color: Theme.accent)

                sectionTitle("If you find one")
                rows(actions, color: Theme.caution)

                Text("No app can find every camera. Trust your eyes too.")
                    .font(.footnote)
                    .foregroundStyle(Theme.dim)
                    .padding(.top, 8)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
        .safeAreaInset(edge: .bottom) {
            Button("Done") { dismiss() }
                .buttonStyle(SecondaryButtonStyle())
                .padding(20)
                .background(Theme.background)
        }
        .background(Theme.background.ignoresSafeArea())
        .presentationDragIndicator(.visible)
    }

    private func sectionTitle(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .textCase(.uppercase)
            .foregroundStyle(Theme.dim)
            .padding(.top, 12)
    }

    private func rows(_ items: [Item], color: Color) -> some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: item.symbol)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(color)
                        .frame(width: 28)
                    Text(item.text)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 12)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

#Preview {
    GuideView()
        .preferredColorScheme(.dark)
}
