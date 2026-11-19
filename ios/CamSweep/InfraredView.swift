import SwiftUI
import AVFoundation

struct InfraredView: View {
    @StateObject private var scanner = InfraredScanner()
    @State private var showHelp = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if scanner.access == .denied {
                ContentUnavailableView {
                    Label("Camera access is off", systemImage: "video.slash")
                } description: {
                    Text("Allow the camera in Settings to look for infrared lights.")
                } actions: {
                    Button("Open Settings") { openAppSettings() }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                CameraLayer(scanner: scanner)
                    .ignoresSafeArea()
                VStack {
                    status
                    Spacer()
                    Text(scanner.isFrontCamera
                         ? "Infrared lights glow on screen, even though your eyes can't see them."
                         : "With the torch on, a camera lens shines back as a tiny glint.")
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .padding(20)
            }
        }
        .navigationTitle("Infrared")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if !scanner.isFrontCamera {
                    Button {
                        scanner.toggleTorch()
                    } label: {
                        Image(systemName: scanner.torchOn ? "flashlight.on.fill" : "flashlight.off.fill")
                    }
                    .accessibilityLabel("Torch")
                }
                Button {
                    scanner.flipCamera()
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath.camera")
                }
                .accessibilityLabel("Switch camera")
                Button {
                    showHelp = true
                } label: {
                    Image(systemName: "questionmark.circle")
                }
                .accessibilityLabel("How it works")
            }
        }
        .sheet(isPresented: $showHelp) {
            HelpSheet(title: "Infrared check", steps: [
                .init(symbol: "moon.fill", text: "Turn off the lights and close the curtains."),
                .init(symbol: "iphone", text: "Sweep the phone slowly around the room."),
                .init(symbol: "circle.dotted", text: "A steady glowing dot that your own eyes can't see may be a camera's night-vision light."),
                .init(symbol: "av.remote", text: "To test it, aim a TV remote at the camera and press a button. Its tip should flash on screen."),
                .init(symbol: "flashlight.on.fill", text: "Or switch to the back camera, turn on the torch and look for a tiny glint from a lens."),
            ])
        }
        .onAppear { scanner.start() }
        .onDisappear { scanner.stop() }
        .keepsScreenAwake()
    }

    @ViewBuilder private var status: some View {
        if scanner.torchOn {
            StatusPill(symbol: "flashlight.on.fill", text: "Watch for a tiny glint", color: Theme.accent)
        } else if !scanner.isDark {
            StatusPill(symbol: "lightbulb.fill", text: "Too bright. Turn off the lights.", color: Theme.caution)
        } else if scanner.spots.isEmpty {
            StatusPill(symbol: "eye.fill", text: "No glowing dots in view", color: Theme.accent)
        } else {
            StatusPill(symbol: "exclamationmark.circle.fill",
                       text: scanner.spots.count == 1 ? "1 glowing dot. Look closer." : "\(scanner.spots.count) glowing dots. Look closer.",
                       color: Theme.alert)
        }
    }
}

private struct StatusPill: View {
    let symbol: String
    let text: LocalizedStringKey
    let color: Color

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(color)
            Text(text)
        }
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
        .accessibilityElement(children: .combine)
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
                    CameraPreview(session: scanner.session)
                }
                ForEach(Array(scanner.spots.enumerated()), id: \.offset) { _, spot in
                    Circle()
                        .stroke(Theme.alert, lineWidth: 3)
                        .frame(width: 56, height: 56)
                        .position(place(spot, in: geo.size))
                }
            }
            .animation(.linear(duration: 0.15), value: scanner.spots)
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
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        if let layer = view.layer as? AVCaptureVideoPreviewLayer {
            layer.session = session
            layer.videoGravity = .resizeAspectFill
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
            LinearGradient(colors: [Color(white: 0.10), Color(white: 0.02)], startPoint: .top, endPoint: .bottom)
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
