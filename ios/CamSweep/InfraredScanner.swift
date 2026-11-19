import AVFoundation
import Combine

/// Looks through the camera for unusually bright spots. In a dark room the
/// infrared LEDs that hidden cameras use for night vision show up to a phone
/// camera as glowing dots, even though the eye cannot see them.
final class InfraredScanner: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    enum Access { case unknown, granted, denied }

    let session = AVCaptureSession()
    private weak var previewLayer: AVCaptureVideoPreviewLayer?

    @Published private(set) var access: Access = .unknown
    /// True until the person has been asked for the camera, so the screen
    /// can explain itself before the system prompt appears.
    @Published private(set) var needsPermission =
        !Demo.isOn && AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined
    /// False until the first camera image has been analyzed.
    @Published private(set) var hasImage = false
    /// Bright spots only mean something in the dark.
    @Published private(set) var isDark = false
    /// Centers of bright spots, normalized to 0...1 within the video frame.
    @Published private(set) var spots: [CGPoint] = []
    /// Pixel size of the video frame the spots refer to.
    @Published private(set) var frameSize = CGSize(width: 480, height: 640)
    @Published private(set) var isFrontCamera = true
    @Published private(set) var torchOn = false

    private let output = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "camsweep.camera.session")
    private let frameQueue = DispatchQueue(label: "camsweep.camera.frames")
    // Touched on sessionQueue only.
    private var configured = false
    private var previewAngle: CGFloat = 90
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
                    self.needsPermission = false
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

    /// Hands over the on-screen preview. The camera needs it to say how
    /// frames must be turned to match what the person sees, and the preview
    /// can appear before or after the camera is set up.
    func attach(preview layer: AVCaptureVideoPreviewLayer) {
        previewLayer = layer
        sessionQueue.async {
            guard let device = (self.session.inputs.first as? AVCaptureDeviceInput)?.device else { return }
            self.matchPreviewRotation(for: device)
            self.alignPreview()
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
            self.alignPreview()
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
                self.alignPreview()
            }
            if !self.session.isRunning { self.session.startRunning() }
        }
    }

    private func attachCamera(_ position: AVCaptureDevice.Position) {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)

        matchPreviewRotation(for: device)
        if let connection = output.connection(with: .video), connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = (position == .front)
        }
    }

    /// Turns the analyzed frames exactly like the preview, or the rings land
    /// in the wrong place. The angle is not a constant: the front camera of
    /// the iPhone 17 family is mounted a quarter turn from earlier ones.
    /// Session queue only.
    private func matchPreviewRotation(for device: AVCaptureDevice) {
        if let previewLayer {
            previewAngle = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
                .videoRotationAngleForHorizonLevelPreview
        }
        if let connection = output.connection(with: .video),
           connection.isVideoRotationAngleSupported(previewAngle) {
            connection.videoRotationAngle = previewAngle
        }
    }

    /// Turns the preview to the same angle as the analyzed frames. Call on
    /// the session queue once a configuration change is committed.
    private func alignPreview() {
        let angle = previewAngle
        DispatchQueue.main.async {
            guard let connection = self.previewLayer?.connection,
                  connection.isVideoRotationAngleSupported(angle) else { return }
            connection.videoRotationAngle = angle
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

        // Every pixel is tested, because a distant LED is only a pixel or two
        // wide. Hits are recorded per 8-pixel cell to keep the work bounded.
        let cell = 8
        let columns = (width + cell - 1) / cell
        let rows = (height + cell - 1) / cell
        var bright = [Bool](repeating: false, count: columns * rows)
        var totalLuma = 0

        for y in 0..<height {
            var offset = y * bytesPerRow // BGRA
            let cellRow = (y / cell) * columns
            for x in 0..<width {
                let b = Int(pixels[offset])
                let g = Int(pixels[offset + 1])
                let r = Int(pixels[offset + 2])
                let luma = (299 * r + 587 * g + 114 * b) / 1000
                totalLuma += luma
                if luma > 230 { bright[cellRow + x / cell] = true }
                offset += 4
            }
        }

        let average = Double(totalLuma) / Double(width * height)
        // Two thresholds, so the status does not flicker at the boundary.
        let dark = average < (wasDark ? 70 : 55)
        wasDark = dark

        var points: [CGPoint] = []
        if dark {
            for index in bright.indices where bright[index] {
                points.append(CGPoint(x: (Double(index % columns) + 0.5) * Double(cell) / Double(width),
                                      y: (Double(index / columns) + 0.5) * Double(cell) / Double(height)))
            }
        }
        let found = Self.cluster(points)
        let size = CGSize(width: width, height: height)
        // iOS turns the torch off by itself (in the background, when hot), so
        // ask the camera instead of remembering the last tap.
        let torch = (connection.inputPorts.first?.input as? AVCaptureDeviceInput)?.device.isTorchActive ?? false

        DispatchQueue.main.async {
            self.hasImage = true
            self.isDark = dark
            self.spots = found
            if self.frameSize != size { self.frameSize = size }
            if self.torchOn != torch { self.torchOn = torch }
        }
    }

    /// Merges nearby bright cells so each light source gets one marker.
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
        // An LED is small. Keeping the smallest clusters stops one large
        // bright area (a window, a TV) from using up every marker.
        return centers.sorted { $0.count < $1.count }.prefix(12).map {
            CGPoint(x: $0.sumX / CGFloat($0.count), y: $0.sumY / CGFloat($0.count))
        }
    }
}
