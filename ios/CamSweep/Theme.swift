import SwiftUI
import UIKit

/// The look of the app. It is dark on purpose: the infrared check needs a
/// dark room, and a bright screen would light it up.
enum Theme {
    static let background = Color(red: 0.035, green: 0.043, blue: 0.063)
    static let surface = Color.white.opacity(0.07)
    static let accent = Color(red: 0.36, green: 0.89, blue: 0.76)
    static let caution = Color(red: 1.00, green: 0.74, blue: 0.33)
    static let alert = Color(red: 1.00, green: 0.38, blue: 0.40)
    static let dim = Color.white.opacity(0.62)
}

/// Soft rings drifting outward: the app's "scanning" motif.
struct Ripples: View {
    var color: Color = Theme.accent
    var isActive = true

    var body: some View {
        TimelineView(.animation(paused: !isActive)) { timeline in
            // At rest the rings hold still, always in the same place.
            let time = isActive ? timeline.date.timeIntervalSinceReferenceDate : 0
            ZStack {
                ForEach(0..<3, id: \.self) { index in
                    let phase = (time / 3 + Double(index) / 3).truncatingRemainder(dividingBy: 1)
                    Circle()
                        .stroke(color, lineWidth: 1.5)
                        .scaleEffect(0.4 + 0.6 * phase)
                        .opacity(0.5 * (1 - phase))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// A round emblem with a symbol in the middle, used as each screen's hero.
struct Emblem: View {
    let symbol: String
    var color: Color = Theme.accent
    var isActive = false

    var body: some View {
        ZStack {
            Ripples(color: color, isActive: isActive)
            Circle()
                .fill(color.opacity(0.14))
                .frame(width: 112, height: 112)
            Image(systemName: symbol)
                .font(.system(size: 44, weight: .semibold))
                .foregroundStyle(color)
        }
        .frame(width: 240, height: 240)
        .accessibilityHidden(true)
    }
}

/// The one main action on a screen.
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(Theme.background)
            .frame(maxWidth: .infinity, minHeight: 54)
            .background(Theme.accent, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

/// A quieter action next to (or instead of) the main one.
struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 54)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

/// A big headline with one supporting line, centered.
struct Headline: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    var color: Color = .white

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.title2.bold())
                .foregroundStyle(color)
            Text(detail)
                .font(.callout)
                .foregroundStyle(Theme.dim)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }
}

/// Short how-to steps, shown from the "?" on each check.
struct HelpSheet: View {
    struct Step: Identifiable {
        let id = UUID()
        let symbol: String
        let text: LocalizedStringKey
    }

    let title: LocalizedStringKey
    let steps: [Step]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text(title)
                    .font(.title2.bold())
                    .padding(.top, 16)
                ForEach(steps) { step in
                    HStack(alignment: .top, spacing: 16) {
                        Image(systemName: step.symbol)
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(Theme.accent)
                            .frame(width: 32)
                        Text(step.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .safeAreaInset(edge: .bottom) {
            Button("Got it") { dismiss() }
                .buttonStyle(SecondaryButtonStyle())
                .padding(.horizontal, 24)
                .padding(.vertical, 12)
                .background(Theme.background)
        }
        .background(Theme.background.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

extension View {
    /// Keeps the screen awake while a hands-busy check is on screen.
    func keepsScreenAwake() -> some View {
        onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }
}

@MainActor
func openAppSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url)
    }
}
