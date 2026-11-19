import SwiftUI
import AVFoundation

struct InfraredView: View {
    @StateObject private var scanner = InfraredScanner()
    @State private var showHelp = false

    var body: some View {
        Group {
            if scanner.access == .denied {
                Stage {
                    Halo(size: 72, isLead: false) { Image(systemName: "video.slash") }
                    StatusBlock(title: "Camera access is off",
                                detail: "Allow the camera for CamSweep in Settings.")
                } actions: {
                    Button("Open Settings") { openAppSettings() }
                        .buttonStyle(CapsuleButtonStyle(isPrimary: true))
                }
            } else if scanner.needsPermission {
                // Ask for the camera after a tap, with the reason on screen.
                Stage {
                    RingGauge {
                        Image(systemName: "moon.fill")
                            .font(.system(size: 56, weight: .medium))
                            .foregroundStyle(Theme.secondary)
                    }
                    StatusBlock(title: "Make the room dark",
                                detail: "Night-vision lights show up on camera, though your eyes can't see them.")
                } actions: {
                    Button("Start camera") { scanner.start() }
                        .buttonStyle(CapsuleButtonStyle(isPrimary: true))
                }
            } else {
                camera
            }
        }
        .toolbarBackground(.hidden, for: .navigationBar)
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
            HelpSheet(title: "Look for infrared",
                      steps: ["Lights off, curtains closed.",
                              "Pan the phone slowly around the room.",
                              "A ring marks a glowing dot. If your eyes can't see it, look closer."],
                      tip: "To test it, aim a TV remote at the camera and press a button: its tip flashes on screen. Or flip to the back camera and use the torch to catch the glint of a lens.")
        }
        .onChange(of: scanner.isFrontCamera && !scanner.spots.isEmpty) { _, showing in
            if showing { announce("Glowing dot in view") }
        }
        .onAppear {
            if !scanner.needsPermission { scanner.start() }
        }
        .onDisappear { scanner.stop() }
    }

    private var camera: some View {
        ZStack(alignment: .bottom) {
            CameraLayer(scanner: scanner)
                .ignoresSafeArea()
            if isTooBright {
                // A lit preview would light the room, and the person's face.
                Color.black.opacity(0.6)
                    .ignoresSafeArea()
            }
            // Keeps the navigation bar readable over a bright image: full
            // strength behind the bar, fading out below it.
            LinearGradient(colors: [.black.opacity(0.7), .black.opacity(0.7), .clear],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: 180)
                .frame(maxHeight: .infinity, alignment: .top)
                .ignoresSafeArea()
                .allowsHitTesting(false)
            panel
                .padding(12)
        }
        .background(Color.black.ignoresSafeArea())
    }

    private var isTooBright: Bool {
        scanner.hasImage && scanner.isFrontCamera && !scanner.isDark
    }

    /// Status and controls together at the bottom, in thumb reach.
    private var panel: some View {
        let status = self.status
        return HStack(spacing: 14) {
            Halo(size: 56, isLead: status.isLead) {
                if let count = status.count {
                    Text("\(count)")
                } else {
                    Image(systemName: status.symbol)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(status.title)
                    .font(.title3.bold())
                Text(status.detail)
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondary)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 4)
            if !scanner.isFrontCamera {
                Button {
                    scanner.toggleTorch()
                } label: {
                    Image(systemName: scanner.torchOn ? "flashlight.on.fill" : "flashlight.off.fill")
                        .frame(width: 48, height: 48)
                        .background(Theme.text.opacity(0.1), in: Circle())
                }
                .accessibilityLabel("Torch")
                .accessibilityValue(scanner.torchOn ? "On" : "Off")
            }
            Button {
                scanner.flipCamera()
            } label: {
                Image(systemName: "arrow.triangle.2.circlepath.camera")
                    .frame(width: 48, height: 48)
                    .background(Theme.text.opacity(0.1), in: Circle())
            }
            .accessibilityLabel("Switch camera")
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    private struct Status {
        var count: Int?
        var symbol = "eye"
        let title: LocalizedStringKey
        let detail: LocalizedStringKey
        var isLead = false
    }

    private var status: Status {
        if !scanner.hasImage {
            return Status(symbol: "camera", title: "Starting camera", detail: "One moment.")
        }
        if !scanner.isFrontCamera {
            // The back camera filters infrared out; it is for the glint test.
            return scanner.torchOn
                ? Status(symbol: "flashlight.on.fill", title: "Watch for a glint", detail: "A lens shines back as a tiny point.")
                : Status(symbol: "flashlight.off.fill", title: "Turn on the torch", detail: "A lens shines back as a tiny point.")
        }
        if !scanner.isDark {
            return Status(symbol: "sun.max.fill", title: "Too bright", detail: "Lights off, curtains closed.")
        }
        if scanner.spots.isEmpty {
            return Status(title: "No glowing dots yet", detail: "Keep panning slowly.")
        }
        return Status(count: scanner.spots.count,
                      title: scanner.spots.count == 1 ? "Glowing dot" : "Glowing dots",
                      detail: "Could be a camera light. Look closer.",
                      isLead: true)
    }
}

/// The camera image with a ring around each bright spot.
private struct CameraLayer: View {
    @ObservedObject var scanner: InfraredScanner

    var body: some View {
        GeometryReader { geo in
            ZStack {
                if Demo.isOn {
                    DemoRoom(lights: scanner.spots.map { place($0, in: geo.size) })
                } else {
                    CameraPreview(scanner: scanner)
                }
                // Rings only mean something on the infrared (front) camera.
                if scanner.isFrontCamera {
                    ForEach(Array(scanner.spots.enumerated()), id: \.offset) { _, spot in
                        ZStack {
                            Circle()
                                .strokeBorder(Theme.accent, lineWidth: 2)
                                .frame(width: 56, height: 56)
                            Circle()
                                .strokeBorder(Theme.accent.opacity(0.3), lineWidth: 1)
                                .frame(width: 80, height: 80)
                        }
                        .position(place(spot, in: geo.size))
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }

    /// Maps a spot from the video frame onto the aspect-filled preview.
    private func place(_ spot: CGPoint, in size: CGSize) -> CGPoint {
        let frame = scanner.frameSize
        let scale = max(size.width / max(frame.width, 1), size.height / max(frame.height, 1))
        return CGPoint(x: spot.x * frame.width * scale + (size.width - frame.width * scale) / 2,
                       y: spot.y * frame.height * scale + (size.height - frame.height * scale) / 2)
    }
}

private struct CameraPreview: UIViewRepresentable {
    let scanner: InfraredScanner

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        if let layer = view.layer as? AVCaptureVideoPreviewLayer {
            layer.session = scanner.session
            layer.videoGravity = .resizeAspectFill
            scanner.attach(preview: layer)
        }
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}

/// A stand-in for the camera in sample-data mode: a dark room with two
/// infrared lights.
private struct DemoRoom: View {
    let lights: [CGPoint]

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.07, green: 0.06, blue: 0.10), .black],
                           startPoint: .top, endPoint: .bottom)
            ForEach(Array(lights.enumerated()), id: \.offset) { _, light in
                Circle()
                    .fill(RadialGradient(colors: [.white, Color(red: 0.78, green: 0.62, blue: 1.0), .clear],
                                         center: .center, startRadius: 0, endRadius: 10))
                    .frame(width: 20, height: 20)
                    .position(light)
            }
        }
    }
}

#Preview {
    NavigationStack { InfraredView() }
        .preferredColorScheme(.dark)
}
