import AppKit
import Darwin

private struct Request {
  let id: Int
  let method: String
  let params: Object
}

private final class Wire: @unchecked Sendable {
  private let outputLock = NSLock()

  func emit(_ row: Object) {
    guard var data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
    data.append(10)
    outputLock.lock(); defer { outputLock.unlock() }
    data.withUnsafeBytes { buf in
      guard let base = buf.baseAddress else { return }
      var offset = 0
      while offset < buf.count {
        let size = Darwin.write(STDOUT_FILENO, base.advanced(by: offset), buf.count - offset)
        if size > 0 { offset += size }
        else if size < 0 && errno == EINTR { continue }
        else { break }
      }
    }
  }

  func fail(id: Int?, _ error: HelperError, isAction: Bool = false) {
    var detail: Object = ["code": error.code, "message": error.message]
    if isAction { detail["dispatch"] = error.code == "timeout" ? "unknown" : "not_sent" }
    if let details = error.details { detail["details"] = details }
    emit(["id": id as Any? ?? NSNull(), "ok": false, "error": detail])
  }

  func requests(onEOF: @escaping @Sendable () -> Void) -> AsyncStream<Request> {
    AsyncStream(bufferingPolicy: .bufferingOldest(128)) { stream in
      DispatchQueue.global(qos: .userInitiated).async {
        let limit = 1_048_576
        var line = Data()
        var oversize = false
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
          let size = buffer.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
          if size < 0 && errno == EINTR { continue }
          if size <= 0 { break }
          for byte in buffer.prefix(size) {
            if byte == 10 {
              if oversize {
                self.fail(id: nil, HelperError("invalid_params", "JSON line too long"))
              } else if !line.isEmpty {
                self.accept(line, stream: stream)
              }
              line.removeAll(keepingCapacity: true)
              oversize = false
            } else if line.count < limit { line.append(byte) }
            else { oversize = true }
          }
        }
        if !oversize && !line.isEmpty { self.accept(line, stream: stream) }
        stream.finish()
        onEOF()
      }
    }
  }

  private func accept(_ line: Data, stream: AsyncStream<Request>.Continuation) {
    guard let row = (try? JSONSerialization.jsonObject(with: line)) as? Object else {
      fail(id: nil, HelperError("invalid_params", "expected JSON request object")); return
    }
    let id = try? boundedInt(row["id"], name: "id", default: -1, range: 0...9_007_199_254_740_991)
    guard let id, id >= 0, let method = row["method"] as? String, let params = row["params"] as? Object else {
      fail(id: id == -1 ? nil : id, HelperError("invalid_params", "id, method and params required")); return
    }
    if case .dropped = stream.yield(Request(id: id, method: method, params: params)) {
      fail(id: id, HelperError("internal", "request_queue_full"))
    }
  }
}

final class DispatchRecord: @unchecked Sendable {
  private let lock = NSLock()
  private var confirmed: Object?

  func confirmed(via: String, notes: [String]) {
    lock.lock(); defer { lock.unlock() }
    confirmed = ["sent": true, "via": via, "notes": notes, "changes": [], "observation": "timeout"]
  }

  var timeoutResult: Object? {
    lock.lock(); defer { lock.unlock() }
    return confirmed
  }
}

private final class InputLifetime: @unchecked Sendable {
  private let lock = NSLock()
  private var current: Task<Object, Error>?
  private var closed = false

  func install(_ task: Task<Object, Error>) {
    lock.lock(); defer { lock.unlock() }
    if closed { task.cancel() } else { current = task }
  }

  func clear() { lock.lock(); current = nil; lock.unlock() }

  func close() {
    lock.lock(); defer { lock.unlock() }
    closed = true
    current?.cancel()
  }
}

private final class RequestDeadline: @unchecked Sendable {
  private var pending = true
  private let lock = NSLock()
  func take() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard pending else { return false }
    pending = false
    return true
  }
}

enum HelperMain {
  @MainActor static func run(arguments: [String]) {
    signal(SIGPIPE, SIG_IGN)
    let wire = Wire()
    let service = HelperService()
    let lifetime = InputLifetime()
    let requests = wire.requests {
      lifetime.close()
      // MainActor가 네이티브 호출에 막힌 경우에도 부모 없이 입력 도우미가 남지 않는다.
      DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(400)) { _exit(0) }
      Task { @MainActor in service.hideCursor(animated: false) }
    }
    Task { @MainActor in
      let check = await service.initialize()
      wire.emit(["event": "ready", "protocol": 1])
      wire.emit(["event": "selfCheck", "selfCheck": check])
      for await request in requests {
        let deadline = RequestDeadline()
        let record = DispatchRecord()
        let task = Task { @MainActor in
          try Task.checkCancellation()
          return try await service.handle(method: request.method, params: request.params, record: record)
        }
        lifetime.install(task)
        let watchdog = DispatchWorkItem {
          guard deadline.take() else { return }
          task.cancel()
          // 타임아웃 뒤에는 이 프로세스에서 다음 입력을 받지 않는다. 호출자는 먼저 관측해야 한다.
          DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(400)) { _exit(1) }
          if let sent = record.timeoutResult { wire.emit(["id": request.id, "ok": true, "result": sent]) }
          else { wire.fail(id: request.id, HelperError("timeout"), isAction: request.method == "act") }
          Task { @MainActor in service.hideCursor(animated: false); _exit(1) }
        }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .seconds(15), execute: watchdog)
        let result = await task.result
        watchdog.cancel()
        lifetime.clear()
        guard deadline.take() else { break }
        switch result {
        case .success(let data):
          wire.emit(["id": request.id, "ok": true, "result": data])
          if request.method == "shutdown" { _exit(0) }
        case .failure(let failure): wire.fail(id: request.id, failure as? HelperError ?? HelperError("internal"), isAction: request.method == "act")
        }
      }
      service.hideCursor(animated: false)
      _exit(0)
    }
  }
}
