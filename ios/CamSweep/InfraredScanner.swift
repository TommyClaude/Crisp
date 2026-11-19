import AVFoundation
import Combine

/// Looks through the camera for unusually bright spots. In a dark room the
/// infrared LEDs that hidden cameras use for night vision show up to a phone
/// camera as glowing dots, even though the eye cannot see them.
final class InfraredScanner: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    enum Access { case unknown, granted, denied }

    let session = AVCaptureSession()

    @Published private(set) var access: Access = .unknown
    /// False until the first camera image has been analyzed.
    @Published private(set) var hasImage = false
    /// Bright spots only mean something in the dark.
    @Published private(set) var isDark = false
    /// Centers of bright spots, normalized to 0...1 within the video frame.
    @Published private(set) var spots: [CGPoint] = []
    /// Pixel size of the (portrait) video frame the spots refer to.
    @Published private(set) var frameSize = CGSize(width: 480, height: 640)
    @Published private(set) var isFrontCamera = true
    @Published private(set) var torchOn = false

    private let output = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "camsweep.camera.session")
    private let frameQueue = DispatchQueue(label: "camsweep.camera.frames")
    private var configured = false
    // Touched on frameQueue only.
    private var lastAnalysis = Date.distantPast
    private var wasDark = false

    func start() {
        if Demo.isOn {
            access = .granted
            hasImage = true
            isDark = true
            spots = [CGPoint(x: 0.27, y: 0.36), CGPoint(x: 0.70, y: 0.55)]
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            access = .granted
            run()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    self.access = granted ? .granted : .denied
                    if granted { self.run() }
                }
            }
        default:
            access = .denied
        }
    }

    func stop() {
        torchOn = false
        sessionQueue.async {
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    func flipCamera() {
        isFrontCamera.toggle()
        torchOn = false
        let position: AVCaptureDevice.Position = isFrontCamera ? .front : .back
        sessionQueue.async {
            self.session.beginConfiguration()
            for input in self.session.inputs { self.session.removeInput(input) }
            self.attachCamera(position)
            self.session.commitConfiguration()
        }
    }

    /// The torch helps find lens reflections with the back camera.
    func toggleTorch() {
        sessionQueue.async {
            guard let device = self.session.inputs
                .compactMap({ ($0 as? AVCaptureDeviceInput)?.device })
                .first(where: { $0.hasTorch }) else { return }
            do {
                try device.lockForConfiguration()
                device.torchMode = (device.torchMode == .on) ? .off : .on
                let isOn = device.torchMode == .on
                device.unlockForConfiguration()
                DispatchQueue.main.async { self.torchOn = isOn }
            } catch {
                // The torch is a convenience; ignore failures.
            }
        }
    }

    private func run() {
        sessionQueue.async {
            if !self.configured {
                self.configured = true
                self.session.beginConfiguration()
                self.session.sessionPreset = .vga640x480
                self.output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
                self.output.alwaysDiscardsLateVideoFrames = true
                self.output.setSampleBufferDelegate(self, queue: self.frameQueue)
                if self.session.canAddOutput(self.output) { self.session.addOutput(self.output) }
                self.attachCamera(.front)
                self.session.commitConfiguration()
            }
            if !self.session.isRunning { self.session.startRunning() }
        }
    }

    private func attachCamera(_ position: AVCaptureDevice.Position) {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)

        // Deliver portrait, mirror-matched frames so spots line up with the preview.
        if let connection = output.connection(with: .video) {
            if connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90
            }
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = (position == .front)
            }
        }
    }

    // MARK: - Frame analysis

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        // About six frames a second is plenty for a hand-held sweep.
        guard Date().timeIntervalSince(lastAnalysis) > 0.15 else { return }
        lastAnalysis = Date()

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard width > 0, height > 0,
              let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
        let pixels = base.assumingMemoryBound(to: UInt8.self)

        var totalLuma = 0
        var sampleCount = 0
        var brightPoints: [CGPoint] = []
        let step = 4

        var y = 0
        while y < height {
            var x = 0
            let row = y * bytesPerRow
            while x < width {
                let offset = row + x * 4 // BGRA
                let b = Int(pixels[offset])
                let g = Int(pixels[offset + 1])
                let r = Int(pixels[offset + 2])
                let luma = (299 * r + 587 * g + 114 * b) / 1000
                totalLuma += luma
                sampleCount += 1
                if luma > 230 && brightPoints.count < 400 {
                    brightPoints.append(CGPoint(x: Double(x) / Double(width),
                                                y: Double(y) / Double(height)))
                }
                x += step
            }
            y += step
        }

        let average = Double(totalLuma) / Double(max(sampleCount, 1))
        // Two thresholds, so the status does not flicker at the boundary.
        let dark = average < (wasDark ? 70 : 55)
        wasDark = dark
        let found = dark ? Self.cluster(brightPoints) : []
        let size = CGSize(width: width, height: height)

        DispatchQueue.main.async {
            self.hasImage = true
            self.isDark = dark
            self.spots = found
            if self.frameSize != size { self.frameSize = size }
        }
    }

    /// Merges nearby bright pixels so each light source gets one marker.
    private static func cluster(_ points: [CGPoint], radius: CGFloat = 0.06) -> [CGPoint] {
        var centers: [(sumX: CGFloat, sumY: CGFloat, count: Int)] = []
        for point in points {
            var merged = false
            for index in centers.indices {
                let cx = centers[index].sumX / CGFloat(centers[index].count)
                let cy = centers[index].sumY / CGFloat(centers[index].count)
                if abs(cx - point.x) < radius && abs(cy - point.y) < radius {
                    centers[index].sumX += point.x
                    centers[index].sumY += point.y
                    centers[index].count += 1
                    merged = true
                    break
                }
            }
            if !merged { centers.append((point.x, point.y, 1)) }
        }
        return centers.prefix(12).map {
            CGPoint(x: $0.sumX / CGFloat($0.count), y: $0.sumY / CGFloat($0.count))
        }
    }
}
