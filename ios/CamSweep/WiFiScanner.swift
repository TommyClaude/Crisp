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
    /// The device's own web page, when it has one.
    let url: URL?
}

/// Scans the Wi-Fi network the phone is on for devices that behave like
/// network cameras: it tries the ports cameras listen on at the addresses
/// around the phone, and browses for advertised video services.
@MainActor
final class WiFiScanner: ObservableObject {
    enum Phase { case idle, asking, scanning, finished, denied, noWiFi }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var progress: Double = 0
    @Published private(set) var findings: [Finding] = []
    /// False when the network is larger than the part that gets swept.
    @Published private(set) var sweepsWholeNetwork = true

    var isBusy: Bool { phase == .asking || phase == .scanning }
    var foundLikelyCamera: Bool { findings.contains(where: \.isLikelyCamera) }

    /// RTSP, the streaming protocol nearly every network camera speaks.
    private static let videoPorts: Set<UInt16> = [554, 8554]
    private static let ports: [UInt16] = [554, 8554, 80, 8080, 443]
    private static let videoServices = ["_rtsp._tcp", "_axis-video._tcp"]
    /// The sweep covers at most a /22: the 1022 addresses around the phone.
    private static let widestMask: UInt32 = 0xFFFF_FC00

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
        guard !isBusy, !Demo.isOn else { return }
        guard let network = Self.wifiNetwork() else {
            phase = .noWiFi
            return
        }
        openPorts = [:]
        advertised = []
        findings = []
        progress = 0
        sweepsWholeNetwork = network.mask >= Self.widestMask

        // Only the very first check can have the system prompt in front of
        // it, and that one has to wait for an answer however long it takes.
        let askedBefore = UserDefaults.standard.bool(forKey: "askedLocalNetwork")
        phase = askedBefore ? .scanning : .asking

        task = Task { [weak self] in
            let allowed = await WiFiScanner.localNetworkAllowed(patience: askedBefore ? 3 : nil)
            UserDefaults.standard.set(true, forKey: "askedLocalNetwork")
            guard let self, !Task.isCancelled else { return }
            guard allowed else {
                self.phase = .denied
                return
            }
            self.phase = .scanning
            self.browse()
            let blocked = await self.sweep(network)
            guard !Task.isCancelled else { return }
            self.stopBrowsing()

            if blocked {
                self.phase = .denied
            } else if WiFiScanner.wifiNetwork()?.address != network.address {
                // Wi-Fi dropped or changed under the scan: nothing was checked.
                self.phase = .noWiFi
            } else {
                self.progress = 1
                self.phase = .finished
            }
        }
    }

    func cancel() {
        guard isBusy else { return }
        if phase == .asking {
            // No prompt can be covering the app if Stop could be tapped.
            UserDefaults.standard.set(true, forKey: "askedLocalNetwork")
        }
        task?.cancel()
        task = nil
        stopBrowsing()
        // A half-finished sweep is not a result, unless it already found one.
        phase = foundLikelyCamera ? .finished : .idle
    }

    // MARK: - Port sweep

    private enum Probe { case open, closed, blocked }

    /// Tries every port on every address. Returns true if iOS blocked the
    /// traffic, in which case nothing can be said about the network.
    private func sweep(_ network: (address: UInt32, mask: UInt32)) async -> Bool {
        let mask = max(network.mask, Self.widestMask)
        let first = (network.address & mask) &+ 1
        let last = (network.address | ~mask) &- 1
        guard first <= last else { return false }

        // Port by port rather than host by host: each address then gets five
        // separate chances, seconds apart, instead of one shared second.
        var jobs: [(host: String, port: UInt16)] = []
        for port in Self.ports {
            for ip in first...last where ip != network.address {
                jobs.append(("\(ip >> 24).\((ip >> 16) & 255).\((ip >> 8) & 255).\(ip & 255)", port))
            }
        }

        let total = Double(jobs.count)
        var completed = 0.0
        var blocked = false

        await withTaskGroup(of: (String, UInt16, Probe).self) { group in
            var remaining = jobs.makeIterator()
            func addProbe() {
                guard let job = remaining.next() else { return }
                group.addTask {
                    let result = await WiFiScanner.probe(host: job.host, port: job.port)
                    return (job.host, job.port, result)
                }
            }
            // A sliding window of concurrent probes.
            for _ in 0..<64 { addProbe() }

            for await (host, port, result) in group {
                if Task.isCancelled || result == .blocked {
                    blocked = (result == .blocked)
                    group.cancelAll()
                    break
                }
                completed += 1
                progress = completed / total
                if result == .open {
                    openPorts[host, default: []].insert(port)
                    publish()
                }
                addProbe()
            }
        }
        return blocked
    }

    /// Tries one TCP connection, giving up after the timeout.
    nonisolated private static func probe(host: String, port: UInt16, timeout: TimeInterval = 1) async -> Probe {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return .closed }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
        let once = Once()
        return await withCheckedContinuation { continuation in
            @Sendable func finish(_ result: Probe) {
                guard once.claim() else { return }
                connection.cancel()
                continuation.resume(returning: result)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(.open)
                case .waiting:
                    // Refused or unreachable, so there is no need to wait out
                    // the timer; unless iOS itself is holding the traffic back.
                    let denied = connection.currentPath?.unsatisfiedReason == .localNetworkDenied
                    finish(denied ? .blocked : .closed)
                case .failed:
                    finish(.closed)
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .utility))
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) {
                finish(.closed)
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
                                url: Self.webPage(at: address, open: open)))
        }
        for name in advertised {
            list.append(Finding(id: "service:" + name, name: name, isLikelyCamera: true, url: nil))
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

    /// IPv4 address and netmask of the Wi-Fi interface (en0), in host byte order.
    nonisolated private static func wifiNetwork() -> (address: UInt32, mask: UInt32)? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }

        var pointer: UnsafeMutablePointer<ifaddrs>? = first
        while let current = pointer {
            let interface = current.pointee
            if let sa = interface.ifa_addr, let nm = interface.ifa_netmask,
               sa.pointee.sa_family == sa_family_t(AF_INET),
               String(cString: interface.ifa_name) == "en0" {
                var address = sockaddr_in()
                var mask = sockaddr_in()
                memcpy(&address, sa, MemoryLayout<sockaddr_in>.size)
                memcpy(&mask, nm, MemoryLayout<sockaddr_in>.size)
                return (UInt32(bigEndian: address.sin_addr.s_addr), UInt32(bigEndian: mask.sin_addr.s_addr))
            }
            pointer = interface.ifa_next
        }
        return nil
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
