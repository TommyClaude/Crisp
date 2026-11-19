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
    /// How far the field strength is from the baseline, in microtesla.
    @Published private(set) var microtesla: Double = 0
    @Published private(set) var level: Level = .calibrating

    /// Position on the gauge, 0...1.
    var fraction: Double { min(microtesla / Self.scaleMax, 1) }

    private let motion = CMMotionManager()
    private var baseline: Double = 0
    private var baselineSamples: [Double] = []
    private var smoothed: Double = 0
    private var bestAccuracy = CMMagneticFieldCalibrationAccuracy.uncalibrated

    func start() {
        if Demo.isOn {
            microtesla = 124
            level = .strong
            return
        }
        // Device motion reports the field with the phone's own magnetism
        // removed. The raw magnetometer includes it, so its strength swings
        // by tens of microtesla whenever the phone is merely turned.
        let frame = CMAttitudeReferenceFrame.xArbitraryCorrectedZVertical
        guard motion.isDeviceMotionAvailable,
              CMMotionManager.availableAttitudeReferenceFrames().contains(frame) else {
            isAvailable = false
            return
        }
        resetBaseline()
        bestAccuracy = .uncalibrated
        motion.deviceMotionUpdateInterval = 1.0 / 30.0
        motion.startDeviceMotionUpdates(using: frame, to: .main) { [weak self] data, _ in
            // Until iOS has calibrated the compass, the field reads as zero.
            guard let self, let reading = data?.magneticField,
                  reading.accuracy != .uncalibrated else { return }
            if reading.accuracy.rawValue > self.bestAccuracy.rawValue {
                // A better compass fit shifts every reading, so measure the
                // baseline again. Accuracy has three levels, which bounds this.
                self.bestAccuracy = reading.accuracy
                self.resetBaseline()
            }
            let field = reading.field
            self.handle(sqrt(field.x * field.x + field.y * field.y + field.z * field.z))
        }
    }

    func stop() {
        motion.stopDeviceMotionUpdates()
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

        // Magnets and steel can weaken the field as well as strengthen it.
        microtesla = abs(smoothed - baseline)
        if microtesla >= Self.strongAt {
            level = .strong
        } else if microtesla >= Self.elevatedAt {
            level = .elevated
        } else {
            level = .normal
        }
    }
}
