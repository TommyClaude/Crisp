import SwiftUI
import UIKit
import Accessibility

/// The look of the app.
///
/// It is dark only, on true black: the infrared check needs a dark room and
/// a bright screen would light it up. There is one accent, a warm amber, and
/// it only ever means "look here". Nothing is green, because no result of
/// this app means the room is clear.
enum Theme {
    static let background = Color.black
    static let surface = Color(red: 0.078, green: 0.067, blue: 0.055)
    static let raised = Color(red: 0.133, green: 0.118, blue: 0.098)
    static let hairline = Color(red: 1.0, green: 0.925, blue: 0.824).opacity(0.09)
    static let text = Color(red: 0.961, green: 0.937, blue: 0.902)
    static let secondary = Color(red: 0.659, green: 0.624, blue: 0.576)
    static let accent = Color(red: 1.0, green: 0.71, blue: 0.278)
    static let onAccent = Color(red: 0.106, green: 0.071, blue: 0.016)

    static let cornerRadius: CGFloat = 24
}

/// The app's motif: a soft disc inside a thin ring, holding a symbol or a
/// number. Amber when it marks something to look at, quiet otherwise.
struct Halo<Content: View>: View {
    var size: CGFloat = 56
    var isLead = true
    @ViewBuilder var content: Content

    var body: some View {
        let color = isLead ? Theme.accent : Theme.text
        ZStack {
            Circle()
                .strokeBorder(color.opacity(isLead ? 0.36 : 0.16), lineWidth: 1.5)
            Circle()
                .fill(color.opacity(isLead ? 0.13 : 0.06))
                .padding(size / 10)
            content
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundStyle(isLead ? Theme.accent : Theme.secondary)
        }
        .frame(width: size, height: size)
    }
}

/// The large ring every check is built around: the magnet gauge, the scan
/// progress, or simply a frame for a symbol.
struct RingGauge<Center: View>: View {
    var fraction: Double = 0
    var isLead = false
    @ViewBuilder var center: Center

    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.text.opacity(0.09), lineWidth: 10)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(isLead ? Theme.accent : Theme.text.opacity(0.75),
                        style: StrokeStyle(lineWidth: 10, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .shadow(color: isLead ? Theme.accent.opacity(0.45) : .clear, radius: 10)
                .animation(.easeOut(duration: 0.25), value: fraction)
            center
        }
        .frame(width: 232, height: 232)
        .padding(14)
        .accessibilityElement(children: .ignore)
    }
}

/// The status of a check: one title and one supporting line, centered.
struct StatusBlock: View {
    var symbol: String?
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    var isLead = false

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                if let symbol {
                    Image(systemName: symbol)
                }
                Text(title)
            }
            .font(.title.bold())
            .foregroundStyle(isLead ? Theme.accent : Theme.text)
            .accessibilityAddTraits(.isHeader)

            Text(detail)
                .font(.callout)
                .foregroundStyle(Theme.secondary)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }
}

/// The layout every check shares: a hero and its status in the middle, one
/// action at the bottom, in thumb reach. Scrolls only if large text needs it.
struct Stage<Hero: View, Actions: View>: View {
    @ViewBuilder var hero: Hero
    @ViewBuilder var actions: Actions

    var body: some View {
        let content = VStack(spacing: 28) { hero }
        VStack(spacing: 12) {
            ViewThatFits(in: .vertical) {
                content.frame(maxHeight: .infinity)
                ScrollView { content }
            }
            actions
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
    }
}

/// Buttons are capsules; containers never are. `isPrimary` fills the button
/// with the accent, for the one action that starts something.
struct CapsuleButtonStyle: ButtonStyle {
    var isPrimary = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(isPrimary ? Theme.onAccent : Theme.text)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(isPrimary ? Theme.accent : Theme.raised, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: isPrimary ? 0 : 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

extension View {
    /// The shared container look: one radius, one fill, a hairline edge.
    func card() -> some View {
        background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous)
                .strokeBorder(Theme.hairline, lineWidth: 1))
    }
}

/// Three numbered steps, shown from the "?" on each check.
struct HelpSheet: View {
    let title: LocalizedStringKey
    let steps: [LocalizedStringKey]
    var tip: LocalizedStringKey?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(title)
                    .font(.title.bold())
                    .padding(.top, 20)
                    .accessibilityAddTraits(.isHeader)

                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    HStack(spacing: 16) {
                        Halo(size: 44) { Text("\(index + 1)") }
                            .accessibilityHidden(true)
                        Text(step)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if let tip {
                    Text(tip)
                        .font(.subheadline)
                        .foregroundStyle(Theme.secondary)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .card()
                }

                Text("Whatever a check shows is a clue, not proof.")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .safeAreaInset(edge: .bottom) {
            Button("Got it") { dismiss() }
                .buttonStyle(CapsuleButtonStyle())
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(Theme.surface)
        }
        .foregroundStyle(Theme.text)
        .background(Theme.surface.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// Speaks a result to VoiceOver, ahead of whatever focus change comes with it.
@MainActor
func announce(_ text: String) {
    var message = AttributedString(text)
    message.accessibilitySpeechAnnouncementPriority = .high
    AccessibilityNotification.Announcement(message).post()
}

@MainActor
func openAppSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url)
    }
}
