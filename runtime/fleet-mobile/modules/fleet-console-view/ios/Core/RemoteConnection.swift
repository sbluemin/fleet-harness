import Foundation
import Network
import Security

// RemoteConnection.kt의 이식. 원격 콘솔로의 모든 연결은 시스템 CA를 쓰지 않는 leaf-only
// 핀 TLS다: TLS 1.2/1.3만, IP 리터럴엔 SNI 생략, ALPN 미제공(HTTP/2 회피), 8초 타임아웃,
// 리다이렉트 거부. join/verifyReachable은 Android의 HttpsURLConnection 대신 같은 핀 소켓
// 위에서 HttpCodec으로 HTTP/1.1을 직접 말한다 — TLS 경로가 하나로 유지되고 리다이렉트
// 미추적·헤더 통제가 코드로 보장된다.
//
// 실제 네트워크 동작(핸드셰이크·검증 블록·릴레이)은 기기에서만 검증된다
// [Unverified-on-device]; CI는 컴파일과 순수 로직(authority 검사·실패 매핑)만 증명한다.

public final class RemoteConnection {
  public static let timeoutMs = 8_000

  private let cookies: FleetCookieJar

  public init(cookies: FleetCookieJar) {
    self.cookies = cookies
  }

  // MARK: - Public surface (Kotlin과 동일)

  public func preflight(_ target: PersistedTarget) throws {
    let socket = try openPinnedSocket(target)
    socket.close()
  }

  public func join(_ target: PersistedTarget, token: String?, deviceName: String) throws {
    var body: [String: Any] = ["device": deviceName]
    if let token { body["token"] = token }
    let payload = try JSONSerialization.data(withJSONObject: body)
    let response = try request(target, path: "/api/v1/join", method: "POST", body: payload)
    switch response.code {
    case 200...299:
      return
    case 401:
      throw ConnectionFailure(token == nil ? "remote_host_not_paired" : "remote_link_rejected")
    case 403:
      throw ConnectionFailure("remote_link_host_mismatch")
    case 409:
      throw ConnectionFailure(response.errorCode() == "paired_device_limit" ? "remote_link_device_limit" : "remote_link_control_held")
    // join 가드는 바디를 읽기 전에 거절한다 — 유효한 토큰도 Retry-After가 지나기 전엔 거부되는
    // 대기 상태이지 identity 실패가 아니다.
    case 429:
      throw ConnectionFailure("remote_link_throttled", retryAfterSeconds: response.retryAfterSeconds())
    case 503:
      throw ConnectionFailure("remote_host_busy", retryAfterSeconds: response.retryAfterSeconds())
    default:
      throw ConnectionFailure("remote_link_unverified")
    }
  }

  public func verifyReachable(_ target: PersistedTarget) throws {
    let response = try request(target, path: "/api/v1/status", method: "GET", body: nil)
    if response.code == 401 { throw ConnectionFailure("remote_host_session_expired") }
    if !(200...299).contains(response.code) || !response.isConsoleStatus() {
      throw ConnectionFailure("remote_host_unavailable")
    }
  }

  /// 게이트웨이 릴레이가 업스트림으로 쓰는 새 핀 TLS 소켓.
  public func openPinnedSocket(_ target: PersistedTarget) throws -> PinnedSocket {
    try PinnedSocket.connect(target)
  }

  // MARK: - HTTP over the pinned socket

  private struct HttpResult {
    let code: Int
    let headers: Headers
    let body: Data

    func errorCode() -> String? {
      guard
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
        let error = object["error"] as? String, !error.isEmpty
      else { return nil }
      return error
    }

    func retryAfterSeconds() -> Int? {
      RetryAfterHeader.seconds(headers.first("Retry-After"))
    }

    func isConsoleStatus() -> Bool {
      guard
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
        let name = object["name"] as? String, !name.isEmpty,
        let version = object["version"] as? String, !version.isEmpty
      else { return false }
      return true
    }
  }

  private func request(_ target: PersistedTarget, path: String, method: String, body: Data?) throws -> HttpResult {
    try Self.requireExpectedAuthority(target, "\(target.origin)\(path)")
    let socket = try openPinnedSocket(target)
    defer { socket.close() }
    do {
      var headers = Headers()
      headers.append(name: "Host", value: target.authority)
      headers.append(name: "Accept", value: "application/json")
      // 쿠키는 요청 직전에 읽는다 — jar가 유일한 저장소다.
      if let cookie = try cookies.readRemote(target.origin, target.port) {
        headers.append(name: "Cookie", value: cookie)
      }
      if let body {
        headers.append(name: "Content-Type", value: "application/json")
        headers.append(name: "Content-Length", value: String(body.count))
      }
      headers.append(name: "Connection", value: "close")
      try HttpCodec.writeHead(socket, startLine: "\(method) \(path) HTTP/1.1", headers: headers)
      if let body { try socket.write([UInt8](body)) }
      try socket.flush()

      let response = try HttpCodec.readResponse(socket, requestMethod: method)
      // 원격의 3xx는 어떤 경우에도 따라가지 않는다.
      if (300...399).contains(response.code) { throw ConnectionFailure("remote_link_redirect_refused") }

      let bodyData = try Self.readBody(socket, response)
      // Set-Cookie 반영 실패는 연결 실패다(fail-closed).
      let setCookies = response.headers.values("Set-Cookie")
      if !setCookies.isEmpty {
        do { try cookies.applyRemote(target.origin, target.port, setCookies) }
        catch { throw ConnectionFailure("remote_link_cookie_failed") }
      }
      return HttpResult(code: response.code, headers: response.headers, body: bodyData)
    } catch let failure as ConnectionFailure {
      throw failure
    } catch {
      throw Self.mappedTlsFailure(error)
    }
  }

  private static let maxResponseBodyBytes = 1 << 20 // join/status는 작은 JSON — 1MiB 캡

  private static func readBody(_ socket: PinnedSocket, _ response: HttpResponse) throws -> Data {
    let sink = ByteArrayOutput()
    switch response.bodyKind {
    case .none:
      break
    case .fixed(let length):
      if length > Int64(maxResponseBodyBytes) { throw ConnectionFailure("remote_host_unavailable") }
      try HttpCodec.copyExactly(socket, sink, length: length)
    case .chunked:
      try HttpCodec.copyChunked(socket, sink, decode: true)
    case .untilClose:
      try HttpCodec.copyUntilEof(socket, sink, false)
    }
    if sink.bytes.count > maxResponseBodyBytes { throw ConnectionFailure("remote_host_unavailable") }
    return Data(sink.bytes)
  }

  // MARK: - Pure helpers (CI 테스트 대상)

  static func requireExpectedAuthority(_ target: PersistedTarget, _ value: String) throws {
    guard let uri = LocationUri.parse(value) else { throw ConnectionFailure("remote_link_unverified") }
    let port = uri.port == -1 ? 443 : uri.port
    guard
      uri.scheme == "https", uri.rawUserInfo == nil, uri.rawFragment == nil,
      let host = uri.host, host.caseInsensitiveCompare(target.hostname) == .orderedSame,
      port == target.port
    else { throw ConnectionFailure("remote_link_host_mismatch") }
    let renderedHost = target.hostname.contains(":") ? "[\(target.hostname)]" : target.hostname
    let expectedOrigin = target.port == 443 ? "https://\(renderedHost)" : "https://\(renderedHost):\(target.port)"
    if target.origin != expectedOrigin { throw ConnectionFailure("remote_link_host_mismatch") }
  }

  static func mappedTlsFailure(_ failure: Error) -> ConnectionFailure {
    if let certificate = failure as? CertificateError {
      switch certificate.code {
      case "certificate_pin_mismatch":
        return ConnectionFailure("remote_link_fingerprint_mismatch")
      case "certificate_hostname_mismatch", "certificate_expired", "certificate_not_yet_valid",
           "certificate_not_leaf", "missing_leaf_certificate":
        return ConnectionFailure("remote_link_unverified")
      default:
        break
      }
    }
    return ConnectionFailure("remote_link_unreachable")
  }
}

// NWConnection을 블로킹 IO로 감싼 핀 TLS 소켓. 게이트웨이 릴레이(ByteInput/ByteOutput)와
// HttpCodec이 같은 구현을 소비한다.
public final class PinnedSocket: ByteInput, ByteOutput {
  private let connection: NWConnection
  private let queue = DispatchQueue(label: "fleet-mobile-pinned-socket")
  private var readTimeoutMs: Int? = RemoteConnection.timeoutMs
  // 핸드셰이크 검증 블록이 기록하는 인증서 실패 — 연결 실패 시 매핑에 쓴다.
  private let verifyFailure: FailureBox

  private final class FailureBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: CertificateError?
    func set(_ error: CertificateError) { lock.lock(); value = error; lock.unlock() }
    func get() -> CertificateError? { lock.lock(); defer { lock.unlock() }; return value }
  }

  static func connect(_ target: PersistedTarget) throws -> PinnedSocket {
    let tls = NWProtocolTLS.Options()
    let options = tls.securityProtocolOptions
    sec_protocol_options_set_min_tls_protocol_version(options, .TLSv12)
    sec_protocol_options_set_max_tls_protocol_version(options, .TLSv13)
    // IP 리터럴엔 SNI를 보내지 않는다. 이름이면 SNI 설정(검증은 우리 verify 블록이 전담).
    if !CertificatePolicy.isIpLiteral(target.hostname) {
      sec_protocol_options_set_tls_server_name(options, target.hostname)
    }
    // ALPN을 제공하지 않으므로 업스트림은 HTTP/2를 선택할 수 없다.

    let socket = PinnedSocket(target: target, tls: tls)
    try socket.start(target)
    return socket
  }

  private init(target: PersistedTarget, tls: NWProtocolTLS.Options) {
    // 시스템 신뢰 평가를 우리 leaf-only 핀 정책으로 대체한다. (박스를 로컬로 먼저 만들어
    // self 초기화 완료 전에 클로저가 self를 캡처하지 않게 한다.)
    let box = FailureBox()
    verifyFailure = box
    sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trustRef, complete in
      let trust = sec_trust_copy_ref(trustRef).takeRetainedValue()
      guard
        let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
        let leaf = chain.first
      else {
        box.set(CertificateError("missing_leaf_certificate"))
        complete(false)
        return
      }
      do {
        try CertificatePolicy.verifyLeaf(leaf, target)
        complete(true)
      } catch let failure as CertificateError {
        box.set(failure)
        complete(false)
      } catch {
        box.set(CertificateError("certificate_not_leaf"))
        complete(false)
      }
    }, queue)

    let parameters = NWParameters(tls: tls)
    let host = NWEndpoint.Host(target.hostname)
    let port = NWEndpoint.Port(rawValue: UInt16(target.port)) ?? 443
    connection = NWConnection(host: host, port: port, using: parameters)
  }

  private func start(_ target: PersistedTarget) throws {
    let ready = DispatchSemaphore(value: 0)
    let state = FailureBox()
    connection.stateUpdateHandler = { [verifyFailure] update in
      switch update {
      case .ready:
        ready.signal()
      case .failed, .cancelled:
        // verify 블록이 기록한 실패가 있으면 그것이 원인이다.
        if state.get() == nil, let certificate = verifyFailure.get() { state.set(certificate) }
        else if state.get() == nil { state.set(CertificateError("__transport__")) }
        ready.signal()
      default:
        break
      }
    }
    connection.start(queue: queue)
    if ready.wait(timeout: .now() + .milliseconds(RemoteConnection.timeoutMs)) == .timedOut {
      connection.cancel()
      throw ConnectionFailure("remote_link_unreachable")
    }
    if let failure = state.get() {
      connection.cancel()
      if failure.code == "__transport__" { throw ConnectionFailure("remote_link_unreachable") }
      throw RemoteConnection.mappedTlsFailure(failure)
    }
    connection.stateUpdateHandler = nil
  }

  // MARK: - ByteInput / ByteOutput (블로킹)

  public func read(_ maxLength: Int) throws -> [UInt8] {
    if maxLength <= 0 { return [] }
    let done = DispatchSemaphore(value: 0)
    var result: Result<[UInt8], Error> = .success([])
    connection.receive(minimumIncompleteLength: 1, maximumLength: maxLength) { data, _, isComplete, error in
      if let error {
        result = .failure(ConnectionFailure("remote_link_unreachable"))
        _ = error
      } else if let data, !data.isEmpty {
        result = .success([UInt8](data))
      } else if isComplete {
        result = .success([]) // EOF
      } else {
        result = .success([])
      }
      done.signal()
    }
    let timeout: DispatchTime = readTimeoutMs.map { .now() + .milliseconds($0) } ?? .distantFuture
    if done.wait(timeout: timeout) == .timedOut {
      connection.cancel()
      throw ConnectionFailure("remote_link_unreachable")
    }
    return try result.get()
  }

  public func setReadTimeout(milliseconds: Int?) {
    readTimeoutMs = milliseconds
  }

  public func write(_ bytes: [UInt8]) throws {
    let done = DispatchSemaphore(value: 0)
    var failure: Error?
    connection.send(content: Data(bytes), completion: .contentProcessed { error in
      failure = error
      done.signal()
    })
    if done.wait(timeout: .now() + .milliseconds(RemoteConnection.timeoutMs)) == .timedOut {
      connection.cancel()
      throw ConnectionFailure("remote_link_unreachable")
    }
    if failure != nil { throw ConnectionFailure("remote_link_unreachable") }
  }

  public func flush() throws {
    // NWConnection.send는 버퍼링 없이 전달을 큐잉한다 — 별도 flush 불필요.
  }

  public func close() {
    connection.cancel()
  }
}
