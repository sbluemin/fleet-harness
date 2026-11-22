import Darwin
import Dispatch
import Foundation

/// One bounded frame on stdin (8 ASCII decimal bytes followed by UTF-8 JSON),
/// with a small newline-delimited reply on stdout. Never echo an input frame.
struct PlatformPipe {
  static let version = 1
  let interrupted: () -> Bool

  static func deadline(after seconds: Int) -> DispatchTime {
    .now() + .seconds(seconds)
  }

  func canRead(until deadline: DispatchTime) -> Bool {
    while !interrupted() {
      let now = DispatchTime.now().uptimeNanoseconds
      guard now < deadline.uptimeNanoseconds else { return false }
      var fd = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
      let left = (deadline.uptimeNanoseconds - now) / 1_000_000
      let count = poll(&fd, 1, Int32(max(1, min(100, left))))
      if count > 0 { return true } // A hangup also makes read complete.
      if count < 0 && errno != EINTR { return false }
    }
    return false
  }

  func hasExtraInputOrEOF() -> Bool {
    var fd = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
    // Fail closed if stdin is invalid or its state cannot be established.
    return poll(&fd, 1, 0) != 0
  }

  private func read(_ count: Int, until deadline: DispatchTime) -> Data? {
    var bytes = Data(count: count)
    var offset = 0
    while offset < count {
      guard canRead(until: deadline) else { return nil }
      let size = bytes.withUnsafeMutableBytes { buffer in
        Darwin.read(STDIN_FILENO, buffer.baseAddress!.advanced(by: offset), count - offset)
      }
      if size < 0 && errno == EINTR { continue }
      guard size > 0 else { return nil }
      offset += size
    }
    return bytes
  }

  func readFrame(maxBytes: Int, until deadline: DispatchTime) -> Data? {
    guard let header = read(8, until: deadline), header.allSatisfy({ 48...57 ~= $0 }),
          let length = Int(String(decoding: header, as: UTF8.self)), (1...maxBytes).contains(length) else { return nil }
    return read(length, until: deadline)
  }

  static func emit(_ result: [String: Any]) -> Bool {
    guard var data = try? JSONSerialization.data(withJSONObject: result) else { return false }
    data.append(10)
    // Fixed-size replies fit in a pipe and are written to a dedicated stdout.
    do { try FileHandle.standardOutput.write(contentsOf: data); return true }
    catch { return false }
  }
}

/// Signals request orderly cleanup rather than running pasteboard code in a
/// signal handler. The dedicated lease owns this process's SIGTERM handling.
final class PlatformTermination: @unchecked Sendable {
  private let lock = NSLock()
  private var stopping = false
  private let source: DispatchSourceSignal

  init() {
    signal(SIGTERM, SIG_IGN)
    source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    source.setEventHandler { [weak self] in
      guard let self else { return }
      self.lock.lock()
      self.stopping = true
      self.lock.unlock()
    }
    source.resume()
  }

  deinit { source.cancel() }

  var requested: Bool {
    lock.lock(); defer { lock.unlock() }
    return stopping
  }
}
