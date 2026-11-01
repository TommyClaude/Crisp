import SwiftUI
import CoreMotion

/// Uses the magnetometer as a simple electronics/magnet sniffer. Powered
/// cameras, their magnets and transformers distort the magnetic field at
/// very close range (a few centimeters).
final class MagnetometerModel: ObservableObject {
    private let motion = CMMotionManager()

    @Published var available = true
    /// Micro-tesla above the calibrated baseline.
    @Published var delta: Double = 0
    @Published var calibrating = false
    /// Incremented each time the field crosses into "strong" — drives haptics.
    @Published var alarmCount = 0

    static let elevatedThreshold: Double = 30
    static let strongThreshold: Double = 100
    static let gaugeMax: Double = 150

    private var baseline: Double = 0
    private var baselineSamples: [Double] = []
    private var smoothed: Double = 0
    private var inAlarm = false

    var status: (label: String, color: Color) {
        if calibrating { return ("Calibrating — hold the phone still, away from metal", .blue) }
        if delta >= Self.strongThreshold { return ("Strong field — possible hidden electronics or magnet", .red) }
        if delta >= Self.elevatedThreshold { return ("Elevated — move slower around this spot", .orange) }
        return ("Normal", .green)
    }

    func start() {
        guard motion.isMagnetometerAvailable else {
            available = false
            return
        }
        recalibrate()
        motion.magnetometerUpdateInterval = 1.0 / 30.0
        motion.startMagnetometerUpdates(to: .main) { [weak self] data, _ in
            guard let self, let field = data?.magneticField else { return }
            let magnitude = sqrt(field.x * field.x + field.y * field.y + field.z * field.z)
            self.smoothed = self.smoothed == 0 ? magnitude : self.smoothed * 0.6 + magnitude * 0.4

            if self.calibrating {
                self.baselineSamples.append(magnitude)
                if self.baselineSamples.count >= 20 {
                    self.baseline = self.baselineSamples.reduce(0, +) / Double(self.baselineSamples.count)
                    self.calibrating = false
                }
                return
            }

            self.delta = max(0, self.smoothed - self.baseline)
            let strongNow = self.delta >= Self.strongThreshold
            if strongNow && !self.inAlarm { self.alarmCount += 1 }
            self.inAlarm = strongNow
        }
    }

    func stop() {
        motion.stopMagnetometerUpdates()
    }

    /// Re-zero in the middle of the room, away from metal and electronics.
    func recalibrate() {
        baselineSamples = []
        delta = 0
        calibrating = true
    }
}

struct MagnetometerView: View {
    @StateObject private var model = MagnetometerModel()

    var body: some View {
        NavigationStack {
            Group {
                if model.available {
                    meter
                } else {
                    ContentUnavailableView(
                        "No magnetometer",
                        systemImage: "exclamationmark.triangle",
                        description: Text("This device has no magnetometer, so the magnetic scan isn't available.")
                    )
                }
            }
            .navigationTitle("Magnetic Scan")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { model.start() }
            .onDisappear { model.stop() }
            .sensoryFeedback(.warning, trigger: model.alarmCount)
        }
    }

    private var meter: some View {
        VStack(spacing: 24) {
            Spacer()

            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(Int(model.delta))")
                    .font(.system(size: 80, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(model.status.color)
                Text("µT")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }

            ProgressView(value: min(model.delta, MagnetometerModel.gaugeMax),
                         total: MagnetometerModel.gaugeMax)
                .tint(model.status.color)
                .scaleEffect(x: 1, y: 3, anchor: .center)
                .padding(.horizontal, 32)

            Text(model.status.label)
                .font(.headline)
                .foregroundStyle(model.status.color)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            Button {
                model.recalibrate()
            } label: {
                Label("Reset baseline", systemImage: "arrow.counterclockwise")
            }
            .buttonStyle(.bordered)

            Spacer()

            VStack(alignment: .leading, spacing: 6) {
                Text("How to use").font(.headline)
                Text("Stand in the middle of the room and tap Reset baseline. Then move the TOP EDGE of the phone slowly, 2–5 cm away from objects: smoke detectors, clocks, chargers, vents, picture frames. A sudden spike means something magnetic or electronic is inside. Metal pipes, speakers and TVs also trigger it — use spikes as leads, not proof.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.gray.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal)
            .padding(.bottom, 8)
        }
    }
}

#Preview {
    MagnetometerView()
}
