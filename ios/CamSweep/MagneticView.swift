import SwiftUI

struct MagneticView: View {
    @StateObject private var sensor = MagneticSensor()
    @State private var showHelp = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            if sensor.isAvailable {
                VStack(spacing: 32) {
                    Spacer()
                    gauge
                    Headline(title: title, detail: detail, color: color)
                    Spacer()
                    Button("Reset") { sensor.resetBaseline() }
                        .buttonStyle(SecondaryButtonStyle())
                }
                .padding(20)
            } else {
                ContentUnavailableView("No magnetic sensor",
                                       systemImage: "exclamationmark.triangle",
                                       description: Text("This device can't run the magnetic check."))
            }
        }
        .navigationTitle("Magnetic")
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
            HelpSheet(title: "Magnetic check", steps: [
                .init(symbol: "scope", text: "Stand in the middle of the room and tap Reset."),
                .init(symbol: "iphone", text: "Move the top edge of the phone slowly along objects, 2–5 cm away."),
                .init(symbol: "waveform.path.ecg", text: "A sudden jump means electronics or a magnet inside."),
                .init(symbol: "info.circle", text: "Metal, speakers and TVs do this too. A jump is a lead, not proof."),
            ])
        }
        .sensoryFeedback(trigger: sensor.level) { _, new in
            new == .strong ? .warning : nil
        }
        .onAppear { sensor.start() }
        .onDisappear { sensor.stop() }
        .keepsScreenAwake()
    }

    private var gauge: some View {
        ZStack {
            Circle()
                .stroke(Theme.surface, lineWidth: 16)
            Circle()
                .trim(from: 0, to: sensor.fraction)
                .stroke(color, style: StrokeStyle(lineWidth: 16, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.2), value: sensor.fraction)
            VStack(spacing: 0) {
                Text("\(Int(sensor.microtesla))")
                    .font(.system(size: 84, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text("µT")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.dim)
            }
        }
        .frame(width: 248, height: 248)
        .background {
            // A soft glow in the status color; it must not affect layout.
            Circle()
                .fill(RadialGradient(colors: [color.opacity(0.22), .clear],
                                     center: .center, startRadius: 40, endRadius: 170))
                .frame(width: 340, height: 340)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Magnetic field")
        .accessibilityValue("\(Int(sensor.microtesla)) microtesla")
    }

    private var color: Color {
        switch sensor.level {
        case .calibrating: Theme.dim
        case .normal: Theme.accent
        case .elevated: Theme.caution
        case .strong: Theme.alert
        }
    }

    private var title: LocalizedStringKey {
        switch sensor.level {
        case .calibrating: "Calibrating"
        case .normal: "Normal"
        case .elevated: "Something nearby"
        case .strong: "Strong field"
        }
    }

    private var detail: LocalizedStringKey {
        switch sensor.level {
        case .calibrating: "Hold the phone still."
        case .normal: "Move the top of the phone close to objects."
        case .elevated: "Slow down and circle this spot."
        case .strong: "Could be electronics or a magnet."
        }
    }
}

#Preview {
    NavigationStack { MagneticView() }
        .preferredColorScheme(.dark)
}
