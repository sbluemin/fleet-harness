import Foundation
import Network
import Security

// LoopbackGateway.kt의 이식. 로컬 127.0.0.1:port에 단명 인증서로 TLS 서버를 띄우고, WKWebView가
// 그 로컬 오리진만 보게 한다. 각 요청은 Host + 게이트웨이 시크릿 쿠키를 확인한 뒤 새 핀 TLS
// 소켓으로 원격에 릴레이된다(헤더는 GatewayPolicy로 재작성, 원격 3xx 미전달, WS/SSE 스트리밍).
//
// iOS 분기: Android는 랜덤 127.x.y.z를 바인딩하지만 기기에선 127.0.0.1만 가능하므로 host는
// 127.0.0.1, 격리는 OS 할당 포트가 담당한다. 실제 서버 동작은 [Unverified-on-device]; CI는
// 컴파일과 순수 정책(GatewayPolicy/HttpCodec, 별도 테스트)만 증명한다.

public final class LoopbackGateway {
  public static let cookieName = "fleet_mobile_gateway"
  public static let maxConnections = 16
  public static let socketTimeoutMs = 30_000

  private let target: PersistedTarget
  private let remote: RemoteConnection
  private let cookies: FleetCookieJar
  private let localTls: LocalTlsIdentity
  public let secret: String

  private let permits: DispatchSemaphore
  private let queue = DispatchQueue(label: "fleet-mobile-gateway-accept")
  private let workers = DispatchQueue(label: "fleet-mobile-gateway-client", attributes: .concurrent)
  private var listener: NWListener?
  private let running = Atomic(false)
  private let active = ActiveConnections()

  public init(target: PersistedTarget, remote: RemoteConnection, cookies: FleetCookieJar) throws {
    self.target = target
    self.remote = remote
    self.cookies = cookies
    self.localTls = try LocalTlsIdentity.create(target.loopback.host)
    self.secret = Self.randomSecret()
    self.permits = DispatchSemaphore(value: Self.maxConnections)
  }

  public var host: String { target.loopback.host }
  public var port: Int { target.loopback.port }
  public var origin: String { target.loopback.origin }
  public var consoleUrl: String { "\(origin)/console/" }
  public var localCertificate: SecCertificate { localTls.certificate }

  /// WKWebView가 로컬 프록시를 쓰려면 이 쿠키를 로컬 오리진에 들고 있어야 한다.
  /// (WKHTTPCookieStore 주입은 FleetConsoleView가 로드 전에 수행한다.)
  public var localCookieHeader: String {
    "\(Self.cookieName)=\(secret); HttpOnly; Secure; SameSite=Strict; Path=/"
  }

  public func start() throws {
    guard running.compareAndSet(expected: false, new: true) else { return }
    FleetLog.stage("gateway: keychain identity")
    let identity = try localTls.secIdentity()
    FleetLog.stage("gateway: bind (host):(port)")
    let tls = NWProtocolTLS.Options()
    let opts = tls.securityProtocolOptions
    sec_protocol_options_set_local_identity(opts, sec_identity_create(identity)!)
    sec_protocol_options_set_min_tls_protocol_version(opts, .TLSv12)
    sec_protocol_options_set_max_tls_protocol_version(opts, .TLSv13)

    let params = NWParameters(tls: tls)
    params.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: UInt16(port))!)
    params.allowLocalEndpointReuse = true

    let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: UInt16(port))!)
    self.listener = listener
    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    listener.start(queue: queue)
  }

  private func accept(_ connection: NWConnection) {
    guard running.get() else { connection.cancel(); return }
    if permits.wait(timeout: .now()) == .timedOut {
      // 여유 없음 → 503 후 종료.
      connection.start(queue: workers)
      let stream = GatewayClientStream(connection)
      GatewayErrorResponse.write(stream, code: 503, reason: "Gateway busy")
      connection.cancel()
      return
    }
    active.add(connection)
    connection.start(queue: workers)
    workers.async { [weak self] in
      guard let self else { return }
      let stream = GatewayClientStream(connection)
      defer {
        self.active.remove(connection)
        connection.cancel()
        self.permits.signal()
      }
      // 클라이언트 절단이 워커를 탈출해 앱을 죽이면 안 된다.
      do { try self.handle(stream) } catch { /* swallow */ }
    }
  }

  private func handle(_ client: GatewayClientStream) throws {
    client.setReadTimeout(milliseconds: Self.socketTimeoutMs)
    let request: HttpRequest
    do { request = try HttpCodec.readRequest(client) }
    catch { GatewayErrorResponse.write(client, code: 400, reason: "Bad request"); return }

    let expectedHost = "\(host):\(port)"
    guard request.host == expectedHost, request.hasCookie(Self.cookieName, secret) else {
      GatewayErrorResponse.write(client, code: 403, reason: "Forbidden"); return
    }
    if request.method == "CONNECT" || request.target.hasPrefix("http://") || request.target.hasPrefix("https://")
      || !request.target.hasPrefix("/") || request.target.hasPrefix("//") {
      GatewayErrorResponse.write(client, code: 400, reason: "Bad request"); return
    }
    let websocket = request.isWebSocketUpgrade
    let websocketKey = websocket ? request.headers.first("Sec-WebSocket-Key")?.trimmingCharacters(in: .whitespaces) : nil
    if websocket, (websocketKey ?? "").isEmpty {
      GatewayErrorResponse.write(client, code: 400, reason: "Bad WebSocket request"); return
    }

    let upstream: PinnedSocket
    do { upstream = try remote.openPinnedSocket(target) }
    catch { GatewayErrorResponse.write(client, code: 502, reason: "Bad gateway"); return }
    active.addSocket(upstream)
    defer { upstream.close(); active.removeSocket(upstream) }

    do {
      try relayRequest(request, client, upstream, websocket: websocket)
      try relayResponse(request, client, upstream, websocket: websocket, websocketKey: websocketKey)
    } catch {
      GatewayErrorResponse.write(client, code: 502, reason: "Bad gateway")
    }
  }

  private func relayRequest(_ request: HttpRequest, _ client: GatewayClientStream, _ upstream: PinnedSocket, websocket: Bool) throws {
    let remoteCookie = try cookies.readRemote(target.origin, target.port)
    var rewritten = GatewayPolicy.rewriteRequestHeaders(
      request.headers, origin, target.origin, target.authority, remoteCookie, websocket)
    if case .chunked = request.bodyKind {
      var entries = rewritten.entries
      entries.append(Header(name: "Transfer-Encoding", value: "chunked"))
      rewritten = Headers(entries)
    }
    try HttpCodec.writeHead(upstream, startLine: "\(request.method) \(request.target) HTTP/1.1", headers: rewritten)
    switch request.bodyKind {
    case .none:
      try upstream.flush()
    case .fixed(let length):
      try HttpCodec.copyExactly(client, upstream, length: length)
      try upstream.flush()
    case .chunked:
      try HttpCodec.copyChunked(client, upstream, decode: false)
      try upstream.flush()
    case .untilClose:
      throw ConnectionFailure("request_body_until_close")
    }
  }

  private func relayResponse(_ request: HttpRequest, _ client: GatewayClientStream, _ upstream: PinnedSocket, websocket: Bool, websocketKey: String?) throws {
    let response = try HttpCodec.readResponse(upstream, requestMethod: request.method)
    if (300...399).contains(response.code) {
      GatewayErrorResponse.write(client, code: 502, reason: "Remote redirect refused"); return
    }
    if websocket, response.code == 101, !GatewayPolicy.validWebSocketAccept(websocketKey ?? "", response.headers) {
      GatewayErrorResponse.write(client, code: 502, reason: "Bad WebSocket handshake"); return
    }
    let setCookies = response.headers.values("Set-Cookie")
    if !setCookies.isEmpty {
      do { try cookies.applyRemote(target.origin, target.port, setCookies) } catch { /* 정책 위반 쿠키는 버린다 */ }
    }
    let rewritten: Headers
    do { rewritten = try GatewayPolicy.rewriteResponseHeaders(response.headers, target.origin, origin, websocket && response.code == 101) }
    catch { GatewayErrorResponse.write(client, code: 502, reason: "Bad gateway"); return }
    try HttpCodec.writeHead(client, startLine: response.statusLine, headers: rewritten)
    try client.flush()

    if websocket, response.code == 101 {
      client.setReadTimeout(milliseconds: nil)
      upstream.setReadTimeout(milliseconds: nil)
      try relayBidirectionally(client, upstream)
      return
    }
    if response.isEventStream { upstream.setReadTimeout(milliseconds: nil) }
    switch response.bodyKind {
    case .none:
      break
    case .fixed(let length):
      try HttpCodec.copyExactly(upstream, client, length: length, flushEach: response.isEventStream)
    case .chunked:
      try HttpCodec.copyChunked(upstream, client, decode: false, flushEach: response.isEventStream)
    case .untilClose:
      try HttpCodec.copyUntilEof(upstream, client, response.isEventStream)
    }
    try client.flush()
  }

  // 양방향 raw 릴레이: 한쪽이 EOF/오류면 양쪽을 닫는다.
  private func relayBidirectionally(_ client: GatewayClientStream, _ upstream: PinnedSocket) throws {
    let group = DispatchGroup()
    group.enter()
    workers.async {
      defer { group.leave() }
      try? HttpCodec.copyUntilEof(client, upstream, true)
      upstream.close(); client.close()
    }
    try? HttpCodec.copyUntilEof(upstream, client, true)
    upstream.close(); client.close()
    _ = group.wait(timeout: .now() + .seconds(2))
  }

  public func close() {
    guard running.compareAndSet(expected: true, new: false) else { return }
    listener?.cancel()
    active.closeAll()
    localTls.removeFromKeychain()
  }

  private static func randomSecret() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
    return Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

public extension LoopbackIdentity {
  /// iOS 루프백 identity: 127.0.0.1 + OS 할당 포트를 예약한다(bind:0 후 닫음). 게이트웨이가
  /// 그 포트를 다시 바인딩한다(Android ServerSocket(0)과 동일한 TOCTOU, 루프백에선 실용적).
  static func reserve() -> LoopbackIdentity {
    var port = 0
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd >= 0 {
      var addr = sockaddr_in()
      addr.sin_family = sa_family_t(AF_INET)
      addr.sin_addr.s_addr = inet_addr("127.0.0.1")
      addr.sin_port = 0
      let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
      }
      if bound == 0 {
        var out = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &out) {
          $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        port = Int(UInt16(bigEndian: out.sin_port))
      }
      Foundation.close(fd)
    }
    return LoopbackIdentity(host: "127.0.0.1", port: port)
  }
}

// NWListener가 준 클라이언트 연결의 블로킹 ByteInput/ByteOutput 어댑터(TLS는 리스너가 종단).
final class GatewayClientStream: ByteInput, ByteOutput {
  private let connection: NWConnection
  private var readTimeoutMs: Int? = LoopbackGateway.socketTimeoutMs
  init(_ connection: NWConnection) { self.connection = connection }

  func read(_ maxLength: Int) throws -> [UInt8] {
    if maxLength <= 0 { return [] }
    let done = DispatchSemaphore(value: 0)
    var result: [UInt8] = []
    var failed = false
    connection.receive(minimumIncompleteLength: 1, maximumLength: maxLength) { data, _, isComplete, error in
      if error != nil { failed = true }
      else if let data, !data.isEmpty { result = [UInt8](data) }
      _ = isComplete
      done.signal()
    }
    let timeout: DispatchTime = readTimeoutMs.map { .now() + .milliseconds($0) } ?? .distantFuture
    if done.wait(timeout: timeout) == .timedOut { connection.cancel(); throw HttpCodecError("client_timeout") }
    if failed { throw HttpCodecError("client_closed") }
    return result
  }

  func setReadTimeout(milliseconds: Int?) { readTimeoutMs = milliseconds }

  func write(_ bytes: [UInt8]) throws {
    let done = DispatchSemaphore(value: 0)
    var failed = false
    connection.send(content: Data(bytes), completion: .contentProcessed { error in failed = (error != nil); done.signal() })
    if done.wait(timeout: .now() + .milliseconds(LoopbackGateway.socketTimeoutMs)) == .timedOut { connection.cancel(); throw HttpCodecError("client_timeout") }
    if failed { throw HttpCodecError("client_closed") }
  }

  func flush() throws {}
  func close() { connection.cancel() }
}

// 작은 스레드-세이프 헬퍼들.
final class Atomic<T: Equatable>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: T
  init(_ value: T) { self.value = value }
  func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
  func compareAndSet(expected: T, new: T) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if value == expected { value = new; return true }
    return false
  }
}

final class ActiveConnections: @unchecked Sendable {
  private let lock = NSLock()
  private var connections: [NWConnection] = []
  private var sockets: [PinnedSocket] = []
  func add(_ c: NWConnection) { lock.lock(); connections.append(c); lock.unlock() }
  func remove(_ c: NWConnection) { lock.lock(); connections.removeAll { $0 === c }; lock.unlock() }
  func addSocket(_ s: PinnedSocket) { lock.lock(); sockets.append(s); lock.unlock() }
  func removeSocket(_ s: PinnedSocket) { lock.lock(); sockets.removeAll { $0 === s }; lock.unlock() }
  func closeAll() {
    lock.lock(); let cs = connections; let ss = sockets; connections = []; sockets = []; lock.unlock()
    cs.forEach { $0.cancel() }
    ss.forEach { $0.close() }
  }
}
