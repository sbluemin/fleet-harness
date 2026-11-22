import AppKit
import CoreGraphics
import Darwin

private struct Identity: Codable, Equatable {
    let runId: String
    let role: String
    let pid: Int32
    let startedAt: String
    let windowId: UInt32
}

private struct Request: Decodable {
    let action: String
    let expected: Identity?
    let marker: String?
}

private struct Snapshot: Encodable {
    let identity: Identity
    let focused: Bool
    let screenUnlocked: Bool
    let postEventAccess: Bool
    let text: String
    let receivedCount: Int
}

private struct Reply: Encodable {
    var snapshot: Snapshot? = nil
    var posted: Bool? = nil
    var stopping: Bool? = nil
    var error: String? = nil
}

private func startedAt() -> String? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &info, size) == size,
          info.pbi_start_tvsec > 0 else { return nil }
    return String(format: "%llu.%06llu", info.pbi_start_tvsec, info.pbi_start_tvusec)
}

// An absent, non-console, or incompletely identified session is not an unlocked desktop.
private func screenUnlocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return session["kCGSSessionOnConsoleKey"] as? Bool == true
        && session["kCGSessionLoginDoneKey"] as? Bool == true
        && (session["CGSSessionScreenIsLocked"] == nil || session["CGSSessionScreenIsLocked"] as? Bool == false)
}

private final class Receiver: NSView {
    let label = NSTextField(labelWithString: "No test input received")
    var matchesFocus: () -> Bool = { false }
    var pending: (tag: Int64, marker: String)?
    var text = ""
    var receivedCount = 0

    override var acceptsFirstResponder: Bool { true }

    // Only record this fixture's pending test marker after macOS actually dispatches keyDown.
    // Neither an ordinary key press nor the control channel writes the visible test text.
    override func keyDown(with event: NSEvent) {
        guard let pending, matchesFocus(), screenUnlocked(),
              event.cgEvent?.getIntegerValueField(.eventSourceUserData) == pending.tag,
              event.characters == pending.marker else { return }
        self.pending = nil
        text = pending.marker
        receivedCount += 1
        label.stringValue = text
    }
}

@MainActor private final class Fixture {
    let runId: String
    let role: String
    let window: NSWindow
    let receiver: Receiver

    init(runId: String, role: String) {
        self.runId = runId
        self.role = role
        let x: CGFloat = role == "stand-in" ? 60 : 440
        window = NSWindow(contentRect: CGRect(x: x, y: 180, width: 360, height: 140),
                          styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Fleet E2E \(role) · \(runId)"
        window.isRestorable = false
        receiver = Receiver(frame: window.contentView!.bounds)
        let heading = NSTextField(labelWithString: "\(role) · \(runId)")
        heading.frame = CGRect(x: 16, y: 88, width: 328, height: 24)
        receiver.label.frame = CGRect(x: 16, y: 46, width: 328, height: 24)
        receiver.addSubview(heading)
        receiver.addSubview(receiver.label)
        window.contentView = receiver
        receiver.matchesFocus = { [weak self] in self?.focused == true }
        window.makeFirstResponder(receiver)
        window.orderFrontRegardless()
    }

    private var focused: Bool {
        NSApp.isActive && NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()
            && window.isKeyWindow && window.firstResponder === receiver
    }

    private func identity() -> Identity? {
        guard let started = startedAt(), window.isVisible,
              let wid = UInt32(exactly: window.windowNumber), wid > 0,
              let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow, .excludeDesktopElements], wid) as? [[String: Any]],
              rows.contains(where: { ($0[kCGWindowNumber as String] as? UInt32) == wid
                  && ($0[kCGWindowOwnerPID as String] as? Int32) == getpid() }) else { return nil }
        return Identity(runId: runId, role: role, pid: getpid(), startedAt: started, windowId: wid)
    }

    func handle(_ request: Request) -> Reply {
        guard let actual = identity(), request.expected == actual ||
              (request.action == "snapshot" && request.expected == nil) else { return Reply(error: "window_ownership_unverified") }
        switch request.action {
        case "snapshot":
            return Reply(snapshot: Snapshot(identity: actual, focused: focused, screenUnlocked: screenUnlocked(),
                          postEventAccess: CGPreflightPostEventAccess(), text: receiver.text, receivedCount: receiver.receivedCount))
        case "focus":
            guard screenUnlocked() else { return Reply(error: "screen_locked_or_unverified") }
            if #available(macOS 14.0, *) { NSApp.activate() }
            else { NSRunningApplication.current.activate(options: []) }
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(receiver)
            return Reply(posted: false)
        case "input":
            guard screenUnlocked() else { return Reply(error: "screen_locked_or_unverified") }
            guard CGPreflightPostEventAccess() else { return Reply(error: "post_event_access_denied") }
            guard let marker = request.marker, marker.range(of: "\\A[A-Za-z0-9_-]{1,20}\\z", options: .regularExpression) != nil,
                  let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return Reply(error: "invalid_marker_or_event") }
            let tag = Int64.random(in: 1...Int64.max)
            let units = Array(marker.utf16)
            for event in [down, up] {
                event.flags = []
                event.setIntegerValueField(.eventSourceUserData, value: tag)
                units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
            }
            guard identity() == actual, focused, screenUnlocked() else { return Reply(error: "focus_or_ownership_unverified") }
            receiver.pending = (tag, marker)
            // Only this process can receive the OS event. No HID tap, clipboard, or AX write fallback.
            down.postToPid(actual.pid)
            up.postToPid(actual.pid)
            return Reply(posted: true)
        case "stop":
            return Reply(stopping: true)
        default:
            return Reply(error: "unknown_action")
        }
    }
}

private func emit(_ reply: Reply) {
    guard let line = try? JSONEncoder().encode(reply) else { exit(1) }
    FileHandle.standardOutput.write(line + Data([10]))
}

@main private enum FocusWindow {
    @MainActor static func main() {
        let args = CommandLine.arguments
        guard args.count == 3, args[1].range(of: "\\A[0-9a-f]{32}\\z", options: .regularExpression) != nil,
              ["stand-in", "target"].contains(args[2]), screenUnlocked() else {
            fputs("owned-focus-window: invalid launch or locked/unverified screen\n", stderr)
            exit(1)
        }
        let app = NSApplication.shared
        guard app.setActivationPolicy(.regular) else { exit(1) }
        let fixture = Fixture(runId: args[1], role: args[2])
        DispatchQueue.global().async {
            while let line = readLine() {
                let request = try? JSONDecoder().decode(Request.self, from: Data(line.utf8))
                DispatchQueue.main.async {
                    let reply = request.map(fixture.handle) ?? Reply(error: "invalid_request")
                    emit(reply)
                    if reply.stopping == true { app.stop(nil); exit(0) }
                }
            }
            // The private parent pipe leases only this child, including during partial startup.
            DispatchQueue.main.async { app.stop(nil); exit(0) }
        }
        app.run()
    }
}
