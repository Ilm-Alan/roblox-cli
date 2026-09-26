import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation
import Darwin
import IOKit.pwr_mgt
import CoreGraphics

// One grammar for both recording lives:
//
//   record-studio run FILE --seconds N            fixed maximum, then stop
//   record-studio run FILE --socket PATH --state PATH   stop on a control command
//
// A caller that only knows "record for N seconds" omits --socket. The CLI's
// start/stop form passes a control socket, so the recording length is owned by
// the workflow that started it instead of by an arbitrary duration ceiling.
// The CLI always passes --seconds with --socket as a runaway cap, never as the
// mechanism that ends a normal run, so a lost stop cannot record forever.
//
// --start-timeout bounds everything before the start acknowledgement (display
// wake, window binding, ScreenCaptureKit start); the caller waits longer than
// that, so a slow but healthy start is never abandoned while still running.
//
// The window is bound by CGWindowID. Every other Studio window on the desktop
// is refused, so two open Studio processes can never make a recording capture
// an arbitrary one.
//
// The crop rect is expressed in pixels of a calibrated still capture of the
// same window. ScreenCaptureKit expresses sourceRect in points, so the helper
// converts with the filter's own pointPixelScale and refuses a crop whose
// pixel width disagrees with the live window; the caller then falls back to a
// full-window recording instead of silently producing a mis-cropped video.

final class RecordingDelegate: NSObject, SCRecordingOutputDelegate {
    var started = false
    var finished = false
    var failure: Error?
    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) { started = true }
    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) { finished = true }
    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        failure = error
        finished = true
    }
}

/// The stream itself can stop underneath the recording output, for example
/// when the Studio window closes; that must end the recording loop.
final class StreamDelegate: NSObject, SCStreamDelegate {
    var failure: Error?
    func stream(_ stream: SCStream, didStopWithError error: Error) { failure = error }
}

/// Where a failure is recorded once the options are known. Every failure exit
/// rewrites the state file inactive with its reason, so `status` and `stop`
/// report the real cause instead of an active recording that no longer exists.
var failureStatePath: String?
var failureFile = ""
var failureControlPath: String?
/// Set once capture has begun; read by the start watchdog on the main queue,
/// which the awaiting main actor yields to, so it needs no lock.
var startAcknowledged = false

func fail(_ message: String, code: Int32) -> Never {
    try? FileHandle.standardError.write(contentsOf: Data((message + "\n").utf8))
    writeState(failureStatePath, ["active": false, "file": failureFile, "error": message,
                                  "pid": ProcessInfo.processInfo.processIdentifier])
    if let failureControlPath { unlink(failureControlPath) }
    exit(code)
}

/// The caller detaches from stdout once it has the start acknowledgement, so
/// later writes may meet a closed pipe; SIGPIPE is ignored and write errors
/// are thrown instead of killing the recorder.
func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    try FileHandle.standardOutput.write(contentsOf: data + Data([10]))
}

func iso8601(_ date: Date = Date()) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

/// The state file is the only place a second process can learn that a
/// recording exists. Rewriting it atomically means `status` never observes a
/// half-written file, and a crash leaves a stale pid that liveness checks
/// reject.
func writeState(_ path: String?, _ value: [String: Any]) {
    guard let path else { return }
    let url = URL(fileURLWithPath: path)
    let temporary = URL(fileURLWithPath: path + ".\(ProcessInfo.processInfo.processIdentifier).tmp")
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        try data.write(to: temporary)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
    } catch {
        try? FileManager.default.removeItem(at: temporary)
    }
}

/// Minimal AF_UNIX control channel. Only two verbs exist, so the helper adds
/// no general command surface: "stop" finalizes, anything else is answered
/// with the current state and the connection is closed.
final class ControlSocket {
    private let descriptor: Int32
    let path: String

    init?(path: String) {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return nil }
        unlink(path)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        if bytes.count >= capacity {
            close(fd)
            return nil
        }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { destination in
                for (index, byte) in bytes.enumerated() { destination[index] = CChar(bitPattern: byte) }
                destination[bytes.count] = 0
            }
        }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) }
        }
        if bound != 0 {
            close(fd)
            return nil
        }
        chmod(path, 0o600)
        if listen(fd, 4) != 0 {
            close(fd)
            unlink(path)
            return nil
        }
        // accept() must never stall the recording loop when no client is
        // waiting, so the listener is non-blocking.
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        self.descriptor = fd
        self.path = path
    }

    /// Returns the pending stop flag and whether at least one client asked.
    func poll() -> (stopped: Bool, observed: Bool) {
        var stopped = false
        var observed = false
        while true {
            var client = sockaddr_un()
            var length = socklen_t(MemoryLayout<sockaddr_un>.size)
            let connection = withUnsafeMutablePointer(to: &client) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(descriptor, $0, &length) }
            }
            if connection < 0 { break }
            observed = true
            // BSD sockets inherit O_NONBLOCK from the listener, so a client
            // that connected but has not written yet would read as an empty
            // line and its stop would be lost. Read blocking instead, bounded
            // by a receive timeout so a silent client cannot stall the loop.
            let connectionFlags = fcntl(connection, F_GETFL, 0)
            _ = fcntl(connection, F_SETFL, connectionFlags & ~O_NONBLOCK)
            var timeout = timeval(tv_sec: 1, tv_usec: 0)
            _ = setsockopt(connection, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            var received: [UInt8] = []
            var buffer = [UInt8](repeating: 0, count: 256)
            while received.count < 256 && !received.contains(10) {
                let read = recv(connection, &buffer, buffer.count, 0)
                if read <= 0 { break }
                received.append(contentsOf: buffer[0..<Int(read)])
            }
            let line = String(decoding: received, as: UTF8.self)
            if line.trimmingCharacters(in: .whitespacesAndNewlines) == "stop" { stopped = true }
            let reply = stopped ? "{\"stopping\":true}\n" : "{\"active\":true}\n"
            _ = reply.withCString { send(connection, $0, strlen($0), 0) }
            close(connection)
            if stopped { break }
        }
        return (stopped, observed)
    }

    func shutdown() {
        close(descriptor)
        unlink(path)
    }
}

/// A recording of a sleeping display is not a recording at all: ScreenCaptureKit
/// accepts the stream and then fails the first sample buffer (-5822), which
/// looks like a capture bug rather than a power state. Assert the display awake
/// for the recording's lifetime and report the real reason when it cannot be.
final class DisplayAssertion {
    private var identifier: IOPMAssertionID = 0
    private var wakeIdentifier: IOPMAssertionID = 0
    private var created = false
    private var woke = false

    func acquire() -> Bool {
        let reason = "roblox-cli recording captures the live Studio window" as CFString
        // Declaring user activity wakes a display that is already asleep;
        // the assertion alone only prevents a sleeping display going idle
        // again, which is not the same problem.
        let wake = IOPMAssertionDeclareUserActivity(
            kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
            kIOPMUserActiveLocal,
            &wakeIdentifier
        )
        woke = wake == kIOReturnSuccess
        let status = IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            reason,
            &identifier
        )
        created = status == kIOReturnSuccess
        return created
    }

    /// ScreenCaptureKit needs an active display, and waking one is not
    /// instantaneous. Wait for it instead of racing the first sample buffer.
    func waitUntilAwake(seconds: Double) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if displayIsAwake() { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return displayIsAwake()
    }

    func release() {
        if created { IOPMAssertionRelease(identifier) }
        created = false
    }
}

func displayIsAwake() -> Bool {
    let display = CGMainDisplayID()
    return CGDisplayIsActive(display) != 0 && CGDisplayIsAsleep(display) == 0
}

struct Options {
    var file: String
    var seconds: Double?
    var socket: String?
    var state: String?
    var windowId: UInt32?
    var ownerPid: Int32?
    var crop: [Int]?
    var captureWidth: Int?
    var fps: Int = 30
    var startTimeout: Double = 30
}

func parseOptions() -> Options {
    let arguments = CommandLine.arguments
    guard arguments.count >= 3, arguments[1] == "run" else {
        fail("usage: record-studio run FILE.mp4 [--seconds N] [--socket PATH] [--state PATH] [--window-id ID] [--crop x,y,w,h] [--capture-width PX] [--fps N] [--start-timeout N]", code: 1)
    }
    let supportedSeconds = 86_400.0
    var options = Options(file: arguments[2])
    var index = 3
    func value(_ name: String) -> String {
        guard index + 1 < arguments.count else { fail("\(name) requires a value", code: 1) }
        index += 1
        return arguments[index]
    }
    while index < arguments.count {
        let token = arguments[index]
        switch token {
        case "--seconds":
            guard let parsed = Double(value(token)), parsed > 0, parsed <= supportedSeconds else {
                fail("--seconds must be between 0 and \(Int(supportedSeconds))", code: 1)
            }
            options.seconds = parsed
        case "--socket": options.socket = value(token)
        case "--state": options.state = value(token)
        case "--window-id":
            guard let parsed = UInt32(value(token)) else { fail("--window-id must be a positive integer", code: 1) }
            options.windowId = parsed
        case "--owner-pid":
            guard let parsed = Int32(value(token)) else { fail("--owner-pid must be an integer", code: 1) }
            options.ownerPid = parsed
        case "--capture-width":
            guard let parsed = Int(value(token)), parsed > 0 else { fail("--capture-width must be positive", code: 1) }
            options.captureWidth = parsed
        case "--fps":
            guard let parsed = Int(value(token)), parsed > 0, parsed <= 60 else { fail("--fps must be between 1 and 60", code: 1) }
            options.fps = parsed
        case "--start-timeout":
            guard let parsed = Double(value(token)), parsed > 0, parsed <= 300 else { fail("--start-timeout must be between 0 and 300", code: 1) }
            options.startTimeout = parsed
        case "--crop":
            let parts = value(token).split(separator: ",").map(String.init)
            guard parts.count == 4, let x = Int(parts[0]), let y = Int(parts[1]), let width = Int(parts[2]), let height = Int(parts[3]),
                  x >= 0, y >= 0, width > 0, height > 0 else {
                fail("--crop must be x,y,width,height in capture pixels", code: 1)
            }
            options.crop = [x, y, width, height]
        default:
            fail("unknown option \(token)", code: 1)
        }
        index += 1
    }
    guard options.seconds != nil || options.socket != nil else {
        fail("record-studio run requires --seconds or --socket", code: 1)
    }
    return options
}

@main struct StudioRecorder {
    @MainActor static func main() async {
        NSApplication.shared.setActivationPolicy(.prohibited)
        Darwin.signal(SIGPIPE, SIG_IGN)
        let options = parseOptions()
        let url = URL(fileURLWithPath: options.file)
        failureStatePath = options.state
        failureFile = url.path
        guard url.pathExtension.lowercased() == "mp4" else { fail("recording output must end in .mp4", code: 1) }
        guard !FileManager.default.fileExists(atPath: url.path) else {
            fail("recording output already exists: \(url.path)", code: 2)
        }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let control = options.socket.flatMap { ControlSocket(path: $0) }
        if options.socket != nil && control == nil { fail("control socket could not be created", code: 1) }
        failureControlPath = control?.path

        // The whole start is bounded, including ScreenCaptureKit calls that
        // have no timeout of their own.
        DispatchQueue.main.asyncAfter(deadline: .now() + options.startTimeout) {
            if !startAcknowledged { fail("recording did not start within \(Int(options.startTimeout))s", code: 4) }
        }

        do {
            let display = DisplayAssertion()
            _ = display.acquire()
            defer { display.release() }
            guard display.waitUntilAwake(seconds: 5) else {
                fail("the display stayed asleep; ScreenCaptureKit cannot capture a sleeping display. Wake it and retry.", code: 7)
            }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let studios = content.windows.filter {
                $0.owningApplication?.bundleIdentifier == "com.Roblox.RobloxStudio" && $0.windowLayer == 0
                    && $0.frame.width > 400
            }
            // Binding happens on window identity, never on "the first Studio
            // window". A second Studio process must be refused instead of
            // silently captured.
            let window: SCWindow
            if let windowId = options.windowId {
                guard let match = studios.first(where: { $0.windowID == windowId }) else {
                    fail("no visible Studio window has id \(windowId); refusing to record a different window", code: 3)
                }
                window = match
            } else {
                guard studios.count == 1, let only = studios.first else {
                    fail("expected exactly one visible Studio window, found \(studios.count); pass --window-id", code: 3)
                }
                window = only
            }
            if let ownerPid = options.ownerPid, Int32(window.owningApplication?.processID ?? 0) != ownerPid {
                fail("window \(window.windowID) belongs to pid \(window.owningApplication?.processID ?? 0), not \(ownerPid)", code: 3)
            }

            let filter = SCContentFilter(desktopIndependentWindow: window)
            let scale = CGFloat(filter.pointPixelScale)
            let contentRect = filter.contentRect
            let config = SCStreamConfiguration()
            var viewport: [String: Any] = ["mode": "full_window", "reason": "no calibrated crop was requested"]
            if let crop = options.crop {
                if let captureWidth = options.captureWidth {
                    let expectedPixels = Double(contentRect.width) * Double(scale)
                    guard abs(expectedPixels - Double(captureWidth)) <= 2 else {
                        fail("calibrated crop belongs to a \(captureWidth)px capture but the window now measures \(Int(expectedPixels))px; recalibrate", code: 3)
                    }
                }
                let points = CGRect(
                    x: CGFloat(crop[0]) / scale,
                    y: CGFloat(crop[1]) / scale,
                    width: CGFloat(crop[2]) / scale,
                    height: CGFloat(crop[3]) / scale
                )
                let inContent = points.offsetBy(dx: contentRect.origin.x, dy: contentRect.origin.y)
                guard inContent.minX >= contentRect.minX - 1, inContent.minY >= contentRect.minY - 1,
                      inContent.maxX <= contentRect.maxX + 1, inContent.maxY <= contentRect.maxY + 1 else {
                    fail("calibrated crop lies outside the live window; recalibrate", code: 3)
                }
                config.sourceRect = inContent
                config.width = Int(crop[2]) / 2 * 2
                config.height = Int(crop[3]) / 2 * 2
                viewport = [
                    "mode": "calibrated_crop",
                    "crop_in_capture_pixels": ["x": crop[0], "y": crop[1], "width": crop[2], "height": crop[3]],
                    "crop_window_points": ["x": points.origin.x, "y": points.origin.y, "width": points.width, "height": points.height],
                    "capture_width_pixels": options.captureWidth ?? 0,
                    "point_pixel_scale": Double(scale),
                ]
            } else {
                config.width = min(1920, Int(window.frame.width * 2)) / 2 * 2
                config.height = Int(Double(config.width) * window.frame.height / window.frame.width) / 2 * 2
            }
            config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(options.fps))
            config.queueDepth = 5
            config.showsCursor = true
            config.capturesAudio = true
            config.captureMicrophone = false
            config.sampleRate = 48000
            config.channelCount = 2
            let settings = SCRecordingOutputConfiguration()
            settings.outputURL = url
            settings.outputFileType = .mp4
            settings.videoCodecType = .h264
            let delegate = RecordingDelegate()
            let output = SCRecordingOutput(configuration: settings, delegate: delegate)
            let streamDelegate = StreamDelegate()
            let stream = SCStream(filter: filter, configuration: config, delegate: streamDelegate)
            try stream.addRecordingOutput(output)
            let startedAt = Date()
            try await stream.startCapture()
            let startDeadline = Date().addingTimeInterval(10)
            while !delegate.started && delegate.failure == nil && Date() < startDeadline {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            if let failure = delegate.failure { throw failure }
            guard delegate.started else {
                try await stream.stopCapture()
                fail("recording did not start", code: 4)
            }
            startAcknowledged = true

            let state: [String: Any] = [
                "active": true, "file": url.path, "pid": ProcessInfo.processInfo.processIdentifier,
                "socket": options.socket ?? "", "started_at": iso8601(startedAt),
                "window_id": Int(window.windowID), "window_pid": Int(window.owningApplication?.processID ?? 0),
                "window_bounds": ["x": window.frame.origin.x, "y": window.frame.origin.y,
                                  "width": window.frame.width, "height": window.frame.height],
                "width": config.width, "height": config.height, "fps": options.fps,
                "viewport": viewport, "seconds_limit": options.seconds ?? 0,
            ]
            writeState(options.state, state)
            try emit(state.merging(["started": true]) { _, new in new })

            // Recording ends when the owner says so, when the safety cap
            // elapses, on a terminal signal, or when capture ends underneath
            // it (the output failed or finished, or the stream stopped, for
            // example because the window closed). Polling the control socket
            // keeps this a single-threaded async loop with no lock on the
            // capture path.
            let deadline = options.seconds.map { startedAt.addingTimeInterval($0) }
            var stopReason = options.seconds == nil ? "stopped" : "seconds_elapsed"
            var received: Int32 = 0
            Darwin.signal(SIGTERM, SIG_IGN)
            Darwin.signal(SIGINT, SIG_IGN)
            let signals = DispatchSource.makeSignalSource(signal: SIGTERM, queue: DispatchQueue.main)
            signals.setEventHandler { received = SIGTERM }
            signals.resume()
            let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: DispatchQueue.main)
            interrupt.setEventHandler { received = SIGINT }
            interrupt.resume()
            while true {
                if let deadline, Date() >= deadline { stopReason = "seconds_elapsed"; break }
                if let control {
                    let poll = control.poll()
                    if poll.stopped { stopReason = "stopped"; break }
                }
                if received != 0 { stopReason = "signal"; break }
                if delegate.finished || streamDelegate.failure != nil { stopReason = "capture_ended"; break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            control?.shutdown()
            failureControlPath = nil
            Darwin.signal(SIGTERM, SIG_DFL)
            Darwin.signal(SIGINT, SIG_DFL)
            // A stream that already stopped with an error refuses stopCapture;
            // its recording output still finalizes what was captured.
            if streamDelegate.failure == nil { try await stream.stopCapture() } else { try? await stream.stopCapture() }
            let finishDeadline = Date().addingTimeInterval(10)
            while !delegate.finished && Date() < finishDeadline { try await Task.sleep(nanoseconds: 10_000_000) }
            if let failure = delegate.failure { throw failure }
            let captureError = streamDelegate.failure.map { String(describing: $0 as NSError) }
            guard delegate.finished else {
                fail("recording did not finalize" + (captureError.map { ": \($0)" } ?? ""), code: 5)
            }

            let asset = AVURLAsset(url: url)
            let duration = try await asset.load(.duration).seconds
            let audio = try await asset.loadTracks(withMediaType: .audio)
            let video = try await asset.loadTracks(withMediaType: .video)
            guard duration > 0 && !video.isEmpty else { fail("recording contains no video", code: 6) }
            let stoppedAt = Date()
            var receipt: [String: Any] = [
                "file": url.path, "duration_seconds": duration,
                "width": config.width, "height": config.height, "audio_tracks": audio.count,
                "capture_source": "ScreenCaptureKit", "coordinate_space": "window_pixels",
                "microphone": false, "window_id": Int(window.windowID),
                "window_pid": Int(window.owningApplication?.processID ?? 0),
                "fps": options.fps, "stop_reason": stopReason,
                "started_at": iso8601(startedAt), "stopped_at": iso8601(stoppedAt),
                "viewport": viewport,
            ]
            if let captureError { receipt["capture_error"] = captureError }
            writeState(options.state, ["active": false, "file": url.path, "started_at": iso8601(startedAt),
                                       "stopped_at": iso8601(stoppedAt), "stop_reason": stopReason,
                                       "receipt": receipt])
            // The caller usually detached after the start acknowledgement; the
            // state file already carries this receipt.
            try? emit(receipt)
        } catch {
            fail(String(describing: error as NSError), code: 1)
        }
    }
}
