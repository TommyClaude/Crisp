import SwiftUI

struct MagneticView: View {
    @StateObject private var sensor = MagneticSensor()
    @State private var showHelp = false

    var body: some View {
        Group {
            if sensor.isAvailable {
                Stage {
                    RingGauge(fraction: sensor.fraction, isLead: isLead) {
                        VStack(spacing: 0) {
                            Text("\(Int(sensor.microtesla))")
                                .font(.system(size: 80, weight: .bold, design: .rounded))
                                .monospacedDigit()
                                .contentTransition(.numericText())
                            Text("µT")
                                .font(.headline)
                                .foregroundStyle(Theme.secondary)
                        }
                    }
                    .accessibilityLabel("Magnetic field")
                    .accessibilityValue("\(Int(sensor.microtesla)) microtesla")
                    status
                } actions: {
                    Button {
                        sensor.resetBaseline()
                    } label: {
                        Label("Reset", systemImage: "arrow.counterclockwise")
                    }
                    .buttonStyle(CapsuleButtonStyle())
                }
                // The sensor sits at the top of the phone; say so where it is.
                .overlay(alignment: .top) {
                    VStack(spacing: 2) {
                        Image(systemName: "chevron.compact.up")
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(Theme.accent)
                        Text("Sweep with this edge")
                            .font(.subheadline.weight(.medium))
                    }
                    .padding(.top, 4)
                    .accessibilityElement(children: .combine)
                }
            } else {
                Stage {
                    Halo(size: 72, isLead: false) { Image(systemName: "exclamationmark.triangle") }
                    StatusBlock(title: "No magnetic sensor", detail: "This device can't run this check.")
                } actions: {
                    EmptyView()
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
            HelpSheet(title: "Sweep for electronics",
                      steps: ["Stand in the middle of the room and tap Reset.",
                              "Move the top edge of the phone slowly along objects, 2–5 cm away.",
                              "A sudden jump means electronics or a magnet inside."],
                      tip: "Metal, speakers and TVs do this too.")
        }
        .sensoryFeedback(trigger: sensor.level) { _, new in
            new == .strong ? .warning : nil
        }
        .onChange(of: sensor.level) { _, new in
            if new == .strong { AccessibilityNotification.Announcement("Strong field").post() }
        }
        .onAppear { sensor.start() }
        .onDisappear { sensor.stop() }
    }

    private var isLead: Bool {
        sensor.level == .elevated || sensor.level == .strong
    }

    @ViewBuilder private var status: some View {
        switch sensor.level {
        case .calibrating:
            StatusBlock(title: "Calibrating", detail: "Move the phone around slowly.")
        case .normal:
            StatusBlock(title: "Nothing strong here",
                        detail: "Reset mid-room, then trace objects slowly with the top edge.")
        case .elevated:
            StatusBlock(symbol: "dot.radiowaves.left.and.right", title: "Raised field",
                        detail: "Slow down and circle this spot.", isLead: true)
        case .strong:
            StatusBlock(symbol: "exclamationmark.circle.fill", title: "Strong field",
                        detail: "Electronics, a magnet or metal. Look closer.", isLead: true)
        }
    }
}

#Preview {
    NavigationStack { MagneticView() }
        .preferredColorScheme(.dark)
}
