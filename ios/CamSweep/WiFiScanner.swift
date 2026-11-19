import Foundation
import Network
import Combine
import os

/// Something the scan found on the Wi-Fi network.
struct Finding: Identifiable {
    let id: String
    /// IP address, or the advertised name of a video service.
    let name: String
    let isLikelyCamera: Bool
    let ports: [UInt16]
    /// The device's own web page, when it has one.
    let url: URL?
}

/// Scans the Wi-Fi network the phone is on for devices that behave like
/// network cameras: it tries the ports cameras listen on at every address of
/// the local /24 subnet, and browses for advertised video services.
@MainActor
final class WiFiScanner: ObservableObject {
    enum Phase { case idle, asking, scanning, finished, denied, noWiFi }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var progress: Double = 0
    @Published private(set) var findings: [Finding] = []

    var foundLikelyCamera: Bool { findings.contains(where: \.isLikelyCamera) }

    /// RTSP, the streaming protocol nearly every network camera speaks.
    private static let videoPorts: Set<UInt16> = [554, 8554]
    private static let ports: [UInt16] = [80, 443, 554, 8080, 8554]
    private static let videoServices = ["_rtsp._tcp", "_axis-video._tcp"]

    private var openPorts: [String: Set<UInt16>] = [:]
    private var advertised: Set<String> = []
    private var browsers: [NWBrowser] = []
    private var task: Task<Void, Never>?

    init() {
        if Demo.isOn {
            openPorts = ["192.168.1.47": [554, 8080], "192.168.1.1": [80, 443]]
            publish()
            progress = 1
            phase = .finished
        }
    }

    func start() {
        guard phase != .asking, phase != .scanning, !Demo.isOn else { return }
        guard let address = Self.wifiAddress() else {
            phase = .noWiFi
            return
        }
        openPorts = [:]
        advertised = []
        findings = []
        progress = 0
        phase = .asking

        // The very first check has to wait for the person to answer the
        // system prompt, however long that takes. Later ones never should.
        let askedBefore = UserDefaults.standard.bool(forKey: "askedLocalNetwork")
        UserDefaults.standard.set(true, forKey: "askedLocalNetwork")

        task = Task { [weak self] in
            let allowed = await WiFiScanner.localNetworkAllowed(patience: askedBefore ? 3 : nil)
            guard let self, !Task.isCancelled else { return }
            guard allowed else {
                self.phase = .denied
                return
            }
            self.phase = .scanning
            self.browse()
            await self.sweep(around: address)
            guard !Task.isCancelled else { return }
            self.stopBrowsing()
            self.phase = .finished
        }
    }

    func cancel() {
        guard phase == .asking || phase == .scanning else { return }
        task?.cancel()
        task = nil
        stopBrowsing()
        phase = findings.isEmpty ? .idle : .finished
    }

    // MARK: - Port sweep

    private func sweep(around address: String) async {
        let prefix = address.split(separator: ".").prefix(3).joined(separator: ".")
        var jobs: [(host: String, port: UInt16)] = []
        for last in 1...254 {
            let host = "\(prefix).\(last)"
            if host == address { continue }
            for port in Self.ports {
                jobs.append((host, port))
            }
        }

        let total = Double(jobs.count)
        var completed = 0.0

        await withTaskGroup(of: (String, UInt16, Bool).self) { group in
            var remaining = jobs.makeIterator()
            func addProbe() {
                guard let job = remaining.next() else { return }
                group.addTask {
                    let open = await WiFiScanner.isOpen(host: job.host, port: job.port)
                    return (job.host, job.port, open)
                }
            }
            // A sliding window of concurrent probes.
            for _ in 0..<48 { addProbe() }

            for await (host, port, open) in group {
                if Task.isCancelled {
                    group.cancelAll()
                    break
                }
                completed += 1
                progress = completed / total
                if open {
                    openPorts[host, default: []].insert(port)
                    publish()
                }
                addProbe()
            }
        }
    }

    /// True if a TCP connection to host:port succeeds within the timeout.
    nonisolated private static func isOpen(host: String, port: UInt16, timeout: TimeInterval = 1) async -> Bool {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return false }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
        let once = Once()
        return await withCheckedContinuation { continuation in
            @Sendable func finish(_ open: Bool) {
                guard once.claim() else { return }
                connection.cancel()
                continuation.resume(returning: open)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(true)
                case .failed, .waiting:
                    // Refused or unreachable: no need to wait out the timer.
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

    // MARK: - Advertised video services

    private func browse() {
        stopBrowsing()
        for type in Self.videoServices {
            let browser = NWBrowser(for: .bonjour(type: type, domain: nil), using: .tcp)
            browser.browseResultsChangedHandler = { [weak self] results, _ in
                let names = results.compactMap { result -> String? in
                    if case let .service(name, _, _, _) = result.endpoint { return name }
                    return nil
                }
                Task { @MainActor in
                    guard let self, self.phase == .scanning else { return }
                    self.advertised.formUnion(names)
                    self.publish()
                }
            }
            browser.start(queue: .main)
            browsers.append(browser)
        }
    }

    private func stopBrowsing() {
        for browser in browsers { browser.cancel() }
        browsers = []
    }

    // MARK: - Results

    private func publish() {
        var list: [Finding] = []
        for (address, open) in openPorts {
            list.append(Finding(id: address,
                                name: address,
                                isLikelyCamera: !open.isDisjoint(with: Self.videoPorts),
                                ports: open.sorted(),
                                url: Self.webPage(at: address, open: open)))
        }
        for name in advertised {
            list.append(Finding(id: "service:" + name, name: name, isLikelyCamera: true, ports: [], url: nil))
        }
        findings = list.sorted { a, b in
            if a.isLikelyCamera != b.isLikelyCamera { return a.isLikelyCamera }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    private static func webPage(at address: String, open: Set<UInt16>) -> URL? {
        if open.contains(80) { return URL(string: "http://\(address)") }
        if open.contains(8080) { return URL(string: "http://\(address):8080") }
        if open.contains(443) { return URL(string: "https://\(address)") }
        return nil
    }

    // MARK: - Local Network permission

    /// Whether iOS lets this app talk to the local network; shows the system
    /// prompt the first time. iOS has no direct API for this, so the check
    /// advertises a throwaway Bonjour service and browses for it: finding our
    /// own service proves local traffic is allowed.
    ///
    /// Without this, the first scan would run (and find nothing) while the
    /// prompt is still on screen. `patience` bounds the wait once the prompt
    /// can no longer be pending; an inconclusive check lets the scan proceed.
    nonisolated private static func localNetworkAllowed(patience: TimeInterval?) async -> Bool {
        let type = "_camsweep-check._tcp"
        guard let listener = try? NWListener(using: .tcp) else { return true }
        listener.service = NWListener.Service(name: UUID().uuidString, type: type)
        listener.newConnectionHandler = { $0.cancel() }
        let browser = NWBrowser(for: .bonjour(type: type, domain: nil), using: .tcp)
        let queue = DispatchQueue(label: "camsweep.localnetwork")
        let once = Once()

        return await withCheckedContinuation { continuation in
            @Sendable func finish(_ allowed: Bool) {
                guard once.claim() else { return }
                listener.cancel()
                browser.cancel()
                continuation.resume(returning: allowed)
            }
            browser.stateUpdateHandler = { state in
                switch state {
                case .waiting(let error):
                    if WiFiScanner.isPolicyDenial(error) { finish(false) }
                case .failed:
                    finish(true)
                default:
                    break
                }
            }
            browser.browseResultsChangedHandler = { results, _ in
                if !results.isEmpty { finish(true) }
            }
            listener.stateUpdateHandler = { state in
                switch state {
                case .waiting(let error):
                    if WiFiScanner.isPolicyDenial(error) { finish(false) }
                case .failed(let error):
                    finish(!WiFiScanner.isPolicyDenial(error))
                default:
                    break
                }
            }
            listener.start(queue: queue)
            browser.start(queue: queue)
            if let patience {
                queue.asyncAfter(deadline: .now() + patience) { finish(true) }
            }
        }
    }

    nonisolated private static func isPolicyDenial(_ error: NWError) -> Bool {
        // kDNSServiceErr_PolicyDenied
        if case .dns(let code) = error { return code == -65570 }
        return false
    }

    // MARK: - Local address

    /// IPv4 address of the Wi-Fi interface (en0), if any.
    nonisolated private static func wifiAddress() -> String? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }

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

/// Lets exactly one caller through, from any thread.
private struct Once: Sendable {
    private let taken = OSAllocatedUnfairLock(initialState: false)

    func claim() -> Bool {
        taken.withLock { flag in
            if flag { return false }
            flag = true
            return true
        }
    }
}
