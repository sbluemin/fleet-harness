import Foundation

// LoopbackGateway.kt의 HttpCodec/HTTP 타입/GatewayErrorResponse 이식. 헤더/시작줄은 원본과
// 동일하게 ISO-8859-1(latin1, 바이트↔스칼라 1:1)로 다룬다. 프레이밍 한계(64KiB/8KiB),
// CL+TE 동시 거부, 폴디드 헤더 거부 등 요청 스머글링 방어를 그대로 보존한다.

public struct HttpCodecError: Error, Equatable {
  public let reason: String
  public init(_ reason: String) { self.reason = reason }
}

public enum BodyKind: Equatable {
  case none
  case fixed(length: Int64)
  case chunked
  case untilClose
}

public struct HttpRequest: Equatable {
  public let method: String
  public let target: String
  public let headers: Headers
  public let bodyKind: BodyKind

  public var host: String? { headers.first("Host") }

  public var isWebSocketUpgrade: Bool {
    method == "GET"
      && headers.containsToken("Connection", "upgrade")
      && (headers.first("Upgrade")?.caseInsensitiveCompare("websocket") == .orderedSame)
  }

  public func hasCookie(_ name: String, _ expected: String) -> Bool {
    for header in headers.values("Cookie") {
      for piece in header.split(separator: ";", omittingEmptySubsequences: false) {
        let pair = piece.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        if pair.count == 2 && String(pair[0]) == name && String(pair[1]) == expected { return true }
      }
    }
    return false
  }
}

public struct HttpResponse: Equatable {
  public let statusLine: String
  public let code: Int
  public let headers: Headers
  public let bodyKind: BodyKind

  public init(statusLine: String, code: Int, headers: Headers, bodyKind: BodyKind) {
    self.statusLine = statusLine
    self.code = code
    self.headers = headers
    self.bodyKind = bodyKind
  }

  public var isEventStream: Bool {
    guard let ct = headers.first("Content-Type") else { return false }
    let mediaType = ct.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)[0]
      .trimmingCharacters(in: .whitespaces)
    return mediaType.caseInsensitiveCompare("text/event-stream") == .orderedSame
  }
}

public extension Headers {
  // Kotlin Headers.containsToken — 쉼표로 나눈 토큰 중 대소문자 무시 일치.
  func containsToken(_ name: String, _ token: String) -> Bool {
    values(name).flatMap { $0.split(separator: ",", omittingEmptySubsequences: false) }
      .contains { $0.trimmingCharacters(in: .whitespaces).caseInsensitiveCompare(token) == .orderedSame }
  }
}

public enum HttpCodec {
  private static let maxHeaderBytes = 64 * 1024
  private static let maxLineBytes = 8 * 1024
  private static let CR: UInt8 = 0x0d
  private static let LF: UInt8 = 0x0a

  // MARK: - Reading

  public static func readRequest(_ input: ByteInput) throws -> HttpRequest {
    let lines = try readHead(input)
    let parts = lines[0].split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    if parts.count != 3 || parts[2] != "HTTP/1.1" || !isMethod(parts[0]) {
      throw HttpCodecError("bad_request_line")
    }
    let headers = try parseHeaders(Array(lines.dropFirst()))
    if headers.values("Host").count != 1 { throw HttpCodecError("bad_host") }
    return HttpRequest(method: parts[0], target: parts[1], headers: headers, bodyKind: try requestBodyKind(headers))
  }

  public static func readResponse(_ input: ByteInput, requestMethod: String = "GET") throws -> HttpResponse {
    let lines = try readHead(input)
    guard let code = parseStatusCode(lines[0]) else { throw HttpCodecError("bad_status_line") }
    let headers = try parseHeaders(Array(lines.dropFirst()))
    let body: BodyKind
    if requestMethod == "HEAD" || (100...199).contains(code) || code == 204 || code == 304 {
      body = .none
    } else if headers.containsToken("Transfer-Encoding", "chunked") {
      body = .chunked
    } else if headers.first("Content-Length") != nil {
      body = .fixed(length: try contentLength(headers))
    } else {
      body = .untilClose
    }
    try validateFraming(headers)
    return HttpResponse(statusLine: lines[0], code: code, headers: headers, bodyKind: body)
  }

  // MARK: - Writing

  public static func writeHead(_ output: ByteOutput, startLine: String, headers: Headers) throws {
    try output.write(latin1Bytes(startLine + "\r\n"))
    for h in headers.entries {
      try output.write(latin1Bytes("\(h.name): \(h.value)\r\n"))
    }
    try output.write(latin1Bytes("\r\n"))
  }

  // MARK: - Body copying

  public static func copyExactly(_ input: ByteInput, _ output: ByteOutput, length: Int64, flushEach: Bool = false) throws {
    var remaining = length
    while remaining > 0 {
      let want = Int(min(Int64(16 * 1024), remaining))
      let chunk = try input.read(want)
      if chunk.isEmpty { throw HttpCodecError("eof") }
      try output.write(chunk)
      if flushEach { try output.flush() }
      remaining -= Int64(chunk.count)
    }
  }

  public static func copyUntilEof(_ input: ByteInput, _ output: ByteOutput, _ flushEach: Bool) throws {
    while true {
      let chunk = try input.read(16 * 1024)
      if chunk.isEmpty { return }
      try output.write(chunk)
      if flushEach { try output.flush() }
    }
  }

  public static func copyChunked(_ input: ByteInput, _ output: ByteOutput, decode: Bool, flushEach: Bool = false) throws {
    while true {
      let sizeLine = try readLine(input, maxLineBytes)
      let sizeToken = sizeLine.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)[0]
        .trimmingCharacters(in: .whitespaces)
      guard let size = Int64(sizeToken, radix: 16), size >= 0 else { throw HttpCodecError("bad_chunk") }
      if !decode { try output.write(latin1Bytes(sizeLine + "\r\n")) }
      if size == 0 {
        while true {
          let trailer = try readLine(input, maxLineBytes)
          if !decode { try output.write(latin1Bytes(trailer + "\r\n")) }
          if trailer.isEmpty { break }
        }
        return
      }
      try copyExactly(input, output, length: size, flushEach: flushEach)
      if !(try readLine(input, 2)).isEmpty { throw HttpCodecError("bad_chunk") }
      if !decode { try output.write(latin1Bytes("\r\n")) }
    }
  }

  // MARK: - Framing helpers

  private static func requestBodyKind(_ headers: Headers) throws -> BodyKind {
    try validateFraming(headers)
    if headers.containsToken("Transfer-Encoding", "chunked") { return .chunked }
    if headers.first("Content-Length") != nil { return .fixed(length: try contentLength(headers)) }
    return .none
  }

  private static func validateFraming(_ headers: Headers) throws {
    let lengths = headers.values("Content-Length")
    let distinct = Set(lengths)
    if distinct.count > 1 || lengths.contains(where: { Int64($0) == nil || (Int64($0) ?? -1) < 0 }) {
      throw HttpCodecError("bad_length")
    }
    let encodings = headers.values("Transfer-Encoding")
      .flatMap { $0.split(separator: ",", omittingEmptySubsequences: false) }
      .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
    if !lengths.isEmpty && !encodings.isEmpty { throw HttpCodecError("conflicting_framing") }
    if !encodings.isEmpty && encodings != ["chunked"] { throw HttpCodecError("bad_transfer_encoding") }
  }

  private static func contentLength(_ headers: Headers) throws -> Int64 {
    guard let value = headers.first("Content-Length"), let n = Int64(value) else { throw HttpCodecError("bad_length") }
    return n
  }

  // MARK: - Head parsing

  private static func readHead(_ input: ByteInput) throws -> [String] {
    var lines: [String] = []
    var total = 0
    while true {
      let line = try readLine(input, maxLineBytes)
      total += latin1Bytes(line).count + 2
      if total > maxHeaderBytes { throw HttpCodecError("headers_too_large") }
      if line.isEmpty { break }
      lines.append(line)
    }
    if lines.isEmpty { throw HttpCodecError("empty_head") }
    return lines
  }

  private static func parseHeaders(_ lines: [String]) throws -> Headers {
    var headers = Headers()
    for line in lines {
      if line.hasPrefix(" ") || line.hasPrefix("\t") { throw HttpCodecError("folded_header") }
      guard let sep = line.firstIndex(of: ":") else { throw HttpCodecError("bad_header") }
      if sep == line.startIndex { throw HttpCodecError("bad_header") }
      let name = String(line[line.startIndex..<sep])
      let value = String(line[line.index(after: sep)...]).trimmingCharacters(in: .whitespaces)
      if !isTokenName(name) || value.unicodeScalars.contains(where: { $0.value == 0 || $0 == "\r" || $0 == "\n" }) {
        throw HttpCodecError("bad_header")
      }
      headers.append(name: name, value: value)
    }
    return headers
  }

  private static func readLine(_ input: ByteInput, _ limit: Int) throws -> String {
    var bytes: [UInt8] = []
    while bytes.count <= limit {
      guard let value = try readByte(input) else { throw HttpCodecError("eof") }
      if value == CR {
        guard let next = try readByte(input), next == LF else { throw HttpCodecError("bad_line_ending") }
        return latin1String(bytes)
      }
      if value == LF { throw HttpCodecError("bad_line_ending") }
      bytes.append(value)
    }
    throw HttpCodecError("line_too_large")
  }

  private static func readByte(_ input: ByteInput) throws -> UInt8? {
    let chunk = try input.read(1)
    return chunk.first
  }

  // MARK: - Small validators (regex 회피로 이식 정확도 확보)

  private static func isMethod(_ value: String) -> Bool {
    // ^[A-Z]+$
    !value.isEmpty && value.unicodeScalars.allSatisfy { $0.value >= 0x41 && $0.value <= 0x5a }
  }

  private static func isTokenName(_ value: String) -> Bool {
    // ^[!#$%&'*+.^_`|~0-9A-Za-z-]+$ (RFC 9110 token)
    if value.isEmpty { return false }
    for s in value.unicodeScalars {
      let v = s.value
      let isAlnum = (v >= 0x30 && v <= 0x39) || (v >= 0x41 && v <= 0x5a) || (v >= 0x61 && v <= 0x7a)
      let isSymbol = "!#$%&'*+.^_`|~-".unicodeScalars.contains(s)
      if !(isAlnum || isSymbol) { return false }
    }
    return true
  }

  private static func parseStatusCode(_ line: String) -> Int? {
    // ^HTTP/1\.[01] ([0-9]{3})(?: .*)?$
    let scalars = Array(line.unicodeScalars)
    let prefix = Array("HTTP/1.".unicodeScalars)
    guard scalars.count >= prefix.count + 1 + 1 + 3 else { return nil }
    if Array(scalars.prefix(prefix.count)) != prefix { return nil }
    let minorIdx = prefix.count
    guard scalars[minorIdx] == "0" || scalars[minorIdx] == "1" else { return nil }
    guard scalars[minorIdx + 1] == " " else { return nil }
    let codeScalars = scalars[(minorIdx + 2)..<(minorIdx + 5)]
    guard codeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }) else { return nil }
    // 코드 뒤에는 끝이거나 " ..." 만 허용.
    let afterIdx = minorIdx + 5
    if afterIdx < scalars.count && scalars[afterIdx] != " " { return nil }
    return Int(String(String.UnicodeScalarView(codeScalars)))
  }

  // MARK: - latin1

  static func latin1Bytes(_ s: String) -> [UInt8] {
    s.unicodeScalars.map { UInt8($0.value & 0xff) }
  }

  static func latin1String(_ bytes: [UInt8]) -> String {
    var s = ""
    s.unicodeScalars.append(contentsOf: bytes.map { Unicode.Scalar($0) })
    return s
  }
}

// LoopbackGateway.kt GatewayErrorResponse의 이식 — 닫힌 소켓에 써도 예외가 워커를 탈출해
// 프로세스를 죽이지 않게 최선 노력(best-effort)으로 삼킨다.
public enum GatewayErrorResponse {
  public static func write(_ output: ByteOutput, code: Int, reason: String) {
    do {
      let body = Array("\(reason)\n".utf8)
      var headers = Headers()
      headers.append(name: "Content-Type", value: "text/plain; charset=utf-8")
      headers.append(name: "Content-Length", value: String(body.count))
      headers.append(name: "Cache-Control", value: "no-store")
      headers.append(name: "Connection", value: "close")
      try HttpCodec.writeHead(output, startLine: "HTTP/1.1 \(code) \(reason)", headers: headers)
      try output.write(body)
      try output.flush()
    } catch {
      // 닫힌 TLS 소켓은 에러 바디를 받을 수 없다 — 삼키고 워커를 살린다.
    }
  }
}

// 테스트와 소켓 어댑터가 같은 코덱을 쓰기 위한 인메모리 IO 구현.
public final class ByteArrayInput: ByteInput {
  private let bytes: [UInt8]
  private var offset = 0
  public init(_ bytes: [UInt8]) { self.bytes = bytes }
  public convenience init(_ string: String) { self.init(Array(string.utf8)) }
  public func read(_ maxLength: Int) throws -> [UInt8] {
    if offset >= bytes.count || maxLength <= 0 { return [] }
    let end = min(offset + maxLength, bytes.count)
    defer { offset = end }
    return Array(bytes[offset..<end])
  }
  public func setReadTimeout(milliseconds: Int?) {}
}

public final class ByteArrayOutput: ByteOutput {
  public private(set) var bytes: [UInt8] = []
  public private(set) var flushes = 0
  public init() {}
  public func write(_ bytes: [UInt8]) throws { self.bytes.append(contentsOf: bytes) }
  public func flush() throws { flushes += 1 }
  public var utf8String: String { String(decoding: bytes, as: UTF8.self) }
}

// write가 반드시 던지는 출력(닫힌 소켓 시뮬레이션).
public final class ThrowingOutput: ByteOutput {
  public init() {}
  public func write(_ bytes: [UInt8]) throws { throw HttpCodecError("socket_closed") }
  public func flush() throws { throw HttpCodecError("socket_closed") }
}
