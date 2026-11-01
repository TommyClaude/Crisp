import SwiftUI
import AVFoundation
import UIKit

/// Looks through the camera for unusually bright spots. In a dark room,
/// the infrared LEDs that hidden cameras use for night vision show up to
/// a phone camera as glowing white/purple dots even though the human eye
/// cannot see them.
final class IRScanController: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()

    /// Centers of detected bright spots, normalized to 0...1 in buffer space.
    @Published var spots: [CGPoint] = []
    /// Average scene luminance, 0...255.
    @Published var averageBrightness: Double = 255
    /// Size of the (rotated) video buffer, used to map spots onto the preview.
    @Published var bufferSize = CGSize(width: 480, height: 640)
    @Published var permissionDenied = false
    @Published var position: AVCaptureDevice.Position = .front
    @Published var torchOn = false

    /// Scenes darker than this count as "lights off"; bright spots are only
    /// meaningful in the dark.
    static let darkThreshold: Double = 60

    private let output = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "camsweep.session")
    private let processingQueue = DispatchQueue(label: "camsweep.frames")
    private var lastPublish = Date.distantPast
    private var configured = false

    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            setUpAndRun()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted {
                        self.setUpAndRun()
                    } else {
                        self.permissionDenied = true
                    }
                }
            }
        default:
            permissionDenied = true
        }
    }

    func stop() {
        sessionQueue.async {
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    func flipCamera() {
        let newPosition: AVCaptureDevice.Position = (position == .front) ? .back : .front
        position = newPosition
        torchOn = false
        sessionQueue.async {
            self.session.beginConfiguration()
            for input in self.session.inputs { self.session.removeInput(input) }
            self.attachCamera(position: newPosition)
            self.session.commitConfiguration()
        }
    }

    /// Torch helps with the lens-glint check when using the back camera.
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
                // Torch is a convenience; ignore failures.
            }
        }
    }

    private func setUpAndRun() {
        sessionQueue.async {
            if !self.configured {
                self.configureSession()
                self.configured = true
            }
            if !self.session.isRunning { self.session.startRunning() }
        }
    }

    private func configureSession() {
        session.beginConfiguration()
        session.sessionPreset = .vga640x480
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: processingQueue)
        if session.canAddOutput(output) { session.addOutput(output) }
        attachCamera(position: .front)
        session.commitConfiguration()
    }

    private func attachCamera(position: AVCaptureDevice.Position) {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)

        // Deliver portrait, mirror-matched buffers so detected spots line up
        // with the preview layer.
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

    // MARK: - Frame processing

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        // Analyze at most ~6 frames per second; that is plenty for a hand scan.
        guard Date().timeIntervalSince(lastPublish) > 0.15 else { return }
        lastPublish = Date()

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
        let clusters = average < Self.darkThreshold ? Self.cluster(brightPoints) : []

        DispatchQueue.main.async {
            self.averageBrightness = average
            self.spots = clusters
            self.bufferSize = CGSize(width: width, height: height)
        }
    }

    /// Merge nearby bright pixels so each light source gets one marker.
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

/// UIKit host for the AVCaptureSession preview layer.
final class CameraPreviewUIView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> CameraPreviewUIView {
        let view = CameraPreviewUIView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: CameraPreviewUIView, context: Context) {}
}

struct IRScanView: View {
    @StateObject private var controller = IRScanController()

    private var isDark: Bool { controller.averageBrightness < IRScanController.darkThreshold }

    var body: some View {
        NavigationStack {
            Group {
                if controller.permissionDenied {
                    deniedView
                } else {
                    ZStack {
                        CameraPreview(session: controller.session)
                        spotOverlay
                        VStack(spacing: 12) {
                            statusPill
                            Spacer()
                            instructionCard
                        }
                        .padding()
                    }
                    .background(Color.black)
                }
            }
            .navigationTitle("IR Scan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if controller.position == .back {
                        Button {
                            controller.toggleTorch()
                        } label: {
                            Image(systemName: controller.torchOn ? "flashlight.on.fill" : "flashlight.off.fill")
                        }
                    }
                    Button {
                        controller.flipCamera()
                    } label: {
                        Image(systemName: "arrow.triangle.2.circlepath.camera")
                    }
                }
            }
            .onAppear { controller.start() }
            .onDisappear { controller.stop() }
        }
    }

    private var spotOverlay: some View {
        GeometryReader { geo in
            let bufW = max(controller.bufferSize.width, 1)
            let bufH = max(controller.bufferSize.height, 1)
            // The preview uses aspect-fill; reproduce its mapping here.
            let scale = max(geo.size.width / bufW, geo.size.height / bufH)
            let xOffset = (geo.size.width - bufW * scale) / 2
            let yOffset = (geo.size.height - bufH * scale) / 2
            ForEach(Array(controller.spots.enumerated()), id: \.offset) { _, spot in
                Circle()
                    .stroke(Color.red, lineWidth: 3)
                    .frame(width: 44, height: 44)
                    .position(x: spot.x * bufW * scale + xOffset,
                              y: spot.y * bufH * scale + yOffset)
            }
        }
        .allowsHitTesting(false)
    }

    private var statusPill: some View {
        let text: String
        let color: Color
        if !isDark {
            text = "Too bright — turn off the lights"
            color = .orange
        } else if controller.spots.isEmpty {
            text = "Dark enough — scanning, no bright spots"
            color = .green
        } else {
            text = "\(controller.spots.count) bright spot\(controller.spots.count == 1 ? "" : "s") — investigate"
            color = .red
        }
        return Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(color.opacity(0.85), in: Capsule())
    }

    private var instructionCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            if controller.position == .front {
                Text("Find infrared LEDs").font(.headline)
                Text("Turn off all lights and close the curtains, then pan the phone slowly around the room. A steady glowing dot on screen that you can't see with your own eyes may be a camera's night-vision LED. Test it: point a TV remote at this camera and press any button — if its tip flashes on screen, IR detection is working.")
            } else {
                Text("Find lens reflections").font(.headline)
                Text("Turn on the torch (top right) and move slowly, watching suspicious objects head-on. A camera lens reflects the light straight back as a tiny bright glint. Check smoke detectors, clocks, chargers and anything facing the bed or bathroom.")
            }
        }
        .font(.footnote)
        .foregroundStyle(.white)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 12))
    }

    private var deniedView: some View {
        VStack(spacing: 16) {
            Image(systemName: "video.slash")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("Camera access is off")
                .font(.headline)
            Text("CamSweep needs the camera to look for infrared LEDs. Enable it in Settings.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Link("Open Settings", destination: url)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding()
    }
}

#Preview {
    IRScanView()
}
