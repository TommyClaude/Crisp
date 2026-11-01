import SwiftUI
import Network
import Darwin

struct DeviceHit: Identifiable {
    /// The device's IPv4 address.
    let id: String
    var openPorts: Set<UInt16>

    /// RTSP is the streaming protocol used by virtually all network cameras.
    var speaksCameraProtocol: Bool {
        openPorts.contains(554) || openPorts.contains(8554)
    }

    var webURL: URL? {
        if openPorts.contains(80) { return URL(string: "http://\(id)") }
        if openPorts.contains(8080) { return URL(string: "http://\(id):8080") }
        if openPorts.contains(443) { return URL(string: "https://\(id)") }
        return nil
    }
}

struct BonjourHit: Identifiable, Hashable {
    let name: String
    let type: String
    var id: String { name + type }
}

/// Scans the local Wi-Fi subnet for devices listening on ports that network
/// cameras typically use, and browses Bonjour for advertised services.
@MainActor
final class LANScanner: ObservableObject {
    enum Phase: Equatable { case idle, scanning, finished }

    @Published var phase: Phase = .idle
    @Published var progress: Double = 0
    @Published var devices: [DeviceHit] = []
    @Published var bonjourHits: [BonjourHit] = []
    @Published var localIP: String?
    @Published var errorMessage: String?

    static let ports: [UInt16] = [80, 443, 554, 8080, 8554]

    private var browsers: [NWBrowser] = []
    private var scanTask: Task<Void, Never>?

    func start() {
        guard phase != .scanning else { return }
        errorMessage = nil
        devices = []
        bonjourHits = []
        progress = 0

        guard let ip = Self.wifiIPv4() else {
            errorMessage = "No Wi-Fi address found. Join the hotel Wi-Fi first, then try again."
            phase = .idle
            return
        }
        localIP = ip
        phase = .scanning
        startBonjour()

        scanTask = Task { [weak self] in
            await self?.scanSubnet(of: ip)
            guard let self, !Task.isCancelled else { return }
            self.stopBonjour()
            self.phase = .finished
        }
    }

    func cancel() {
        scanTask?.cancel()
        scanTask = nil
        stopBonjour()
        phase = .idle
    }

    // MARK: - Port sweep

    private func scanSubnet(of ip: String) async {
        let parts = ip.split(separator: ".")
        guard parts.count == 4 else { return }
        let prefix = parts[0...2].joined(separator: ".")

        var jobs: [(host: String, port: UInt16)] = []
        for lastOctet in 1...254 {
            let address = "\(prefix).\(lastOctet)"
            if address == ip { continue }
            for port in Self.ports {
                jobs.append((address, port))
            }
        }

        let total = Double(jobs.count)
        var completed: Double = 0
        var found: [String: Set<UInt16>] = [:]

        await withTaskGroup(of: (String, UInt16, Bool).self) { group in
            var iterator = jobs.makeIterator()
            func addNext() {
                if let job = iterator.next() {
                    group.addTask {
                        let open = await Self.probe(host: job.host, port: job.port)
                        return (job.host, job.port, open)
                    }
                }
            }
            // Sliding window of concurrent probes.
            for _ in 0..<48 { addNext() }

            for await (host, port, isOpen) in group {
                if Task.isCancelled {
                    group.cancelAll()
                    break
                }
                completed += 1
                progress = completed / total
                if isOpen {
                    found[host, default: []].insert(port)
                    devices = found
                        .map { DeviceHit(id: $0.key, openPorts: $0.value) }
                        .sorted { Self.lastOctet($0.id) < Self.lastOctet($1.id) }
                }
                addNext()
            }
        }
    }

    nonisolated private static func lastOctet(_ ip: String) -> Int {
        Int(ip.split(separator: ".").last ?? "0") ?? 0
    }

    /// True if a TCP connection to host:port succeeds within the timeout.
    nonisolated private static func probe(host: String, port: UInt16, timeout: TimeInterval = 1.0) async -> Bool {
        await withCheckedContinuation { continuation in
            guard let nwPort = NWEndpoint.Port(rawValue: port) else {
                continuation.resume(returning: false)
                return
            }
            let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
            let lock = NSLock()
            var finished = false
            func finish(_ open: Bool) {
                lock.lock()
                let isFirst = !finished
                finished = true
                lock.unlock()
                guard isFirst else { return }
                connection.cancel()
                continuation.resume(returning: open)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(true)
                case .failed:
                    finish(false)
                case .waiting:
                    // Refused/unreachable — no need to wait out the timer.
                    finish(false)
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .utility))
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) {
                finish(false)
            }
        }
    }

    // MARK: - Bonjour

    private func startBonjour() {
        stopBonjour()
        for type in ["_rtsp._tcp", "_http._tcp", "_axis-video._tcp"] {
            let browser = NWBrowser(for: .bonjour(type: type, domain: nil), using: .tcp)
            browser.browseResultsChangedHandler = { [weak self] results, _ in
                let hits = results.compactMap { result -> BonjourHit? in
                    if case let .service(name, serviceType, _, _) = result.endpoint {
                        return BonjourHit(name: name, type: serviceType)
                    }
                    return nil
                }
                Task { @MainActor in
                    guard let self else { return }
                    for hit in hits where !self.bonjourHits.contains(hit) {
                        self.bonjourHits.append(hit)
                    }
                }
            }
            browser.start(queue: .main)
            browsers.append(browser)
        }
    }

    private func stopBonjour() {
        for browser in browsers { browser.cancel() }
        browsers = []
    }

    // MARK: - Local address

    /// IPv4 address of the Wi-Fi interface (en0), if any.
    nonisolated private static func wifiIPv4() -> String? {
        var ifaddrPointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddrPointer) == 0, let first = ifaddrPointer else { return nil }
        defer { freeifaddrs(ifaddrPointer) }

        var result: String?
        var pointer: UnsafeMutablePointer<ifaddrs>? = first
        while let current = pointer {
            let interface = current.pointee
            if let sa = interface.ifa_addr,
               sa.pointee.sa_family == sa_family_t(AF_INET),
               String(cString: interface.ifa_name) == "en0" {
                var addr = sockaddr_in()
                memcpy(&addr, sa, MemoryLayout<sockaddr_in>.size)
                var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                var sinAddr = addr.sin_addr
                if inet_ntop(AF_INET, &sinAddr, &buffer, socklen_t(INET_ADDRSTRLEN)) != nil {
                    result = String(cString: buffer)
                }
            }
            pointer = interface.ifa_next
        }
        return result
    }
}

struct NetworkScanView: View {
    @StateObject private var scanner = LANScanner()

    var body: some View {
        NavigationStack {
            List {
                controlSection

                if !scanner.devices.isEmpty {
                    Section("Devices with open ports") {
                        ForEach(scanner.devices) { device in
                            deviceRow(device)
                        }
                    }
                }

                if !scanner.bonjourHits.isEmpty {
                    Section("Services advertised on this network") {
                        ForEach(scanner.bonjourHits) { hit in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(hit.name)
                                Text(hit.type == "_rtsp._tcp"
                                     ? "Video stream (RTSP) — likely a camera"
                                     : hit.type)
                                    .font(.caption)
                                    .foregroundStyle(hit.type == "_rtsp._tcp" ? .red : .secondary)
                            }
                        }
                    }
                }

                if scanner.phase == .finished && scanner.devices.isEmpty && scanner.bonjourHits.isEmpty {
                    Section {
                        Label("No devices responded. That's a good sign, but see the notes below.",
                              systemImage: "checkmark.shield")
                            .foregroundStyle(.green)
                    }
                }

                notesSection
            }
            .navigationTitle("Network Scan")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var controlSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Text("Scans the Wi-Fi network you're on for devices listening on ports that network cameras use (RTSP 554/8554, web 80/443/8080).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                if let ip = scanner.localIP, scanner.phase != .idle {
                    Text("Your address: \(ip)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if scanner.phase == .scanning {
                    ProgressView(value: scanner.progress)
                    Button("Stop", role: .destructive) { scanner.cancel() }
                } else {
                    Button {
                        scanner.start()
                    } label: {
                        Label(scanner.phase == .finished ? "Scan again" : "Scan this Wi-Fi",
                              systemImage: "dot.radiowaves.left.and.right")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }

                if let message = scanner.errorMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func deviceRow(_ device: DeviceHit) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(device.id)
                    .font(.body.monospaced())
                Spacer()
                Text(device.openPorts.sorted().map { String($0) }.joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if device.speaksCameraProtocol {
                Label("Streams video (RTSP) — very likely a camera", systemImage: "video.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            } else {
                Label("Has a web interface — could be a router, TV or camera", systemImage: "globe")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let url = device.webURL {
                Link("Open in browser to identify it", destination: url)
                    .font(.caption)
            }
        }
        .padding(.vertical, 2)
    }

    private var notesSection: some View {
        Section("Keep in mind") {
            Label("iOS will ask for Local Network permission on the first scan — it's required.",
                  systemImage: "lock.shield")
            Label("Only devices on the same Wi-Fi show up. A camera recording to a memory card, or using its own SIM or network, is invisible here.",
                  systemImage: "wifi.slash")
            Label("Many hotel networks isolate guests from each other, so an empty result doesn't prove the room is clean.",
                  systemImage: "exclamationmark.triangle")
            Label("Routers, TVs and printers also answer on these ports. A hit is a lead to check, not proof.",
                  systemImage: "questionmark.circle")
        }
        .font(.footnote)
    }
}

#Preview {
    NetworkScanView()
}
