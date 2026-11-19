import CoreMotion
import Combine

/// Uses the magnetometer as a close-range sniffer for electronics and
/// magnets: both disturb the magnetic field within a few centimeters.
final class MagneticSensor: ObservableObject {
    enum Level { case calibrating, normal, elevated, strong }

    static let elevatedAt: Double = 30
    static let strongAt: Double = 100
    static let scaleMax: Double = 150

    @Published private(set) var isAvailable = true
    /// Field strength above the baseline, in microtesla.
    @Published private(set) var microtesla: Double = 0
    @Published private(set) var level: Level = .calibrating

    /// Position on the gauge, 0...1.
    var fraction: Double { min(microtesla / Self.scaleMax, 1) }

    private let motion = CMMotionManager()
    private var baseline: Double = 0
    private var baselineSamples: [Double] = []
    private var smoothed: Double = 0

    func start() {
        if Demo.isOn {
            microtesla = 124
            level = .strong
            return
        }
        guard motion.isMagnetometerAvailable else {
            isAvailable = false
            return
        }
        resetBaseline()
        motion.magnetometerUpdateInterval = 1.0 / 30.0
        motion.startMagnetometerUpdates(to: .main) { [weak self] data, _ in
            guard let self, let field = data?.magneticField else { return }
            self.handle(sqrt(field.x * field.x + field.y * field.y + field.z * field.z))
        }
    }

    func stop() {
        motion.stopMagnetometerUpdates()
    }

    /// Re-zero. Do this in the middle of the room, away from metal.
    func resetBaseline() {
        guard !Demo.isOn else { return }
        baselineSamples = []
        microtesla = 0
        level = .calibrating
    }

    private func handle(_ magnitude: Double) {
        smoothed = smoothed == 0 ? magnitude : smoothed * 0.6 + magnitude * 0.4

        if level == .calibrating {
            baselineSamples.append(magnitude)
            guard baselineSamples.count >= 20 else { return }
            baseline = baselineSamples.reduce(0, +) / Double(baselineSamples.count)
        }

        microtesla = max(0, smoothed - baseline)
        if microtesla >= Self.strongAt {
            level = .strong
        } else if microtesla >= Self.elevatedAt {
            level = .elevated
        } else {
            level = .normal
        }
    }
}
