import Foundation
import CryptoKit

// LoopbackGateway.kt GatewayPolicy의 이식. 로컬 프록시가 원격 콘솔에 자기 오리진을 보게
// 하려고 Host/Origin/Referer/Cookie를 재작성하고, 응답의 Set-Cookie 제거·Location 로컬 한정·
// CSP를 로컬 오리진으로 좁힌다. 규칙은 원본에서 리터럴로 복사했다.
public enum GatewayPolicy {
  public struct PolicyError: Error, Equatable { public let reason: String; public init(_ r: String) { reason = r } }

  private static let fixedHopByHop: Set<String> = [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
  ]

  public static func rewriteRequestHeaders(
    _ headers: Headers,
    _ localOrigin: String,
    _ remoteOrigin: String,
    _ remoteAuthority: String,
    _ remoteCookie: String?,
    _ websocket: Bool
  ) -> Headers {
    let nominated = connectionNominations(headers)
    let omitted = fixedHopByHop.union(nominated).union(["host", "cookie"])
    var result: [Header] = []
    for header in headers.entries where !omitted.contains(header.name.lowercased()) {
      if header.name.caseInsensitiveCompare("Origin") == .orderedSame && header.value == localOrigin {
        result.append(Header(name: header.name, value: remoteOrigin))
      } else if header.name.caseInsensitiveCompare("Referer") == .orderedSame {
        result.append(Header(name: header.name, value: rewriteReferer(header.value, localOrigin, remoteOrigin)))
      } else {
        result.append(header)
      }
    }
    result.append(Header(name: "Host", value: remoteAuthority))
    if let remoteCookie { result.append(Header(name: "Cookie", value: remoteCookie)) }
    if websocket {
      result.append(Header(name: "Connection", value: "Upgrade"))
      result.append(Header(name: "Upgrade", value: "websocket"))
    }
    return Headers(result)
  }

  public static func rewriteResponseHeaders(
    _ headers: Headers,
    _ remoteOrigin: String,
    _ localOrigin: String,
    _ websocket: Bool
  ) throws -> Headers {
    let nominated = connectionNominations(headers)
    let omitted = fixedHopByHop.union(nominated).union(["set-cookie", "transfer-encoding"])
    var result: [Header] = []
    for header in headers.entries where !omitted.contains(header.name.lowercased()) {
      if header.name.caseInsensitiveCompare("Location") == .orderedSame {
        result.append(Header(name: header.name, value: try rewriteLocation(header.value, remoteOrigin, localOrigin)))
      } else if header.name.caseInsensitiveCompare("Content-Security-Policy") == .orderedSame {
        result.append(Header(name: header.name, value: rewriteCsp(header.value, localOrigin)))
      } else {
        result.append(header)
      }
    }
    if !result.contains(where: { $0.name.caseInsensitiveCompare("Content-Security-Policy") == .orderedSame }) {
      result.append(Header(name: "Content-Security-Policy", value: rewriteCsp("default-src 'self'", localOrigin)))
    }
    if websocket {
      result.append(Header(name: "Connection", value: "Upgrade"))
      result.append(Header(name: "Upgrade", value: "websocket"))
    } else {
      if headers.containsToken("Transfer-Encoding", "chunked") {
        result.append(Header(name: "Transfer-Encoding", value: "chunked"))
      }
      result.append(Header(name: "Connection", value: "close"))
    }
    return Headers(result)
  }

  public static func validWebSocketAccept(_ key: String, _ headers: Headers) -> Bool {
    let magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    let latin1 = (key.trimmingCharacters(in: .whitespaces) + magic).unicodeScalars.map { UInt8($0.value & 0xff) }
    let digest = Insecure.SHA1.hash(data: Data(latin1))
    let expected = Data(digest).base64EncodedString()
    return (headers.first("Upgrade")?.caseInsensitiveCompare("websocket") == .orderedSame)
      && headers.containsToken("Connection", "upgrade")
      && headers.first("Sec-WebSocket-Accept") == expected
  }

  public static func rewriteCsp(_ value: String, _ localOrigin: String) -> String {
    let authority = authorityOf(localOrigin)
    var directives = value.split(separator: ";", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
      .filter {
        let name = $0.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)[0].lowercased()
        return name != "connect-src" && name != "report-uri" && name != "report-to"
      }
    directives.append("connect-src 'self' https://\(authority) wss://\(authority)")
    return directives.joined(separator: "; ")
  }

  public static func rewriteLocation(_ value: String, _ remoteOrigin: String, _ localOrigin: String) throws -> String {
    if value.hasPrefix("/") && !value.hasPrefix("//") { return localOrigin + value }
    guard let uri = LocationUri.parse(value) else { throw PolicyError("invalid_location") }
    if uri.isAbsolute, let origin = try? originOf(uri), origin == remoteOrigin {
      var suffix = uri.rawPath.isEmpty ? "/" : uri.rawPath
      if let q = uri.rawQuery { suffix += "?" + q }
      if let f = uri.rawFragment { suffix += "#" + f }
      return localOrigin + suffix
    }
    throw PolicyError("foreign_location")
  }

  private static func rewriteReferer(_ value: String, _ localOrigin: String, _ remoteOrigin: String) -> String {
    if value == localOrigin { return remoteOrigin }
    if value.hasPrefix(localOrigin + "/") { return remoteOrigin + String(value.dropFirst(localOrigin.count)) }
    return value
  }

  private static func connectionNominations(_ headers: Headers) -> Set<String> {
    Set(headers.values("Connection")
      .flatMap { $0.split(separator: ",", omittingEmptySubsequences: false) }
      .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
      .filter { !$0.isEmpty })
  }

  private static func originOf(_ uri: LocationUri) throws -> String {
    guard uri.scheme == "https", uri.rawUserInfo == nil, let host = uri.host else {
      throw PolicyError("invalid_location")
    }
    let port = uri.port == -1 ? 443 : uri.port
    let rendered = host.contains(":") ? "[\(host)]" : host
    return port == 443 ? "https://\(rendered)" : "https://\(rendered):\(port)"
  }

  // origin 문자열("scheme://authority", 경로 없음)에서 authority만 뽑는다.
  private static func authorityOf(_ origin: String) -> String {
    guard let range = origin.range(of: "://") else { return origin }
    let rest = origin[range.upperBound...]
    if let slash = rest.firstIndex(of: "/") { return String(rest[rest.startIndex..<slash]) }
    return String(rest)
  }
}

// Java URI의 필요한 부분만 재현하는 파서(Location/originOf 용). host는 IPv6면 브래킷 없이
// 안쪽만, 포트는 없으면 -1.
struct LocationUri {
  let scheme: String?
  let rawUserInfo: String?
  let host: String?
  let port: Int
  let rawPath: String
  let rawQuery: String?
  let rawFragment: String?
  var isAbsolute: Bool { scheme != nil }

  static func parse(_ value: String) -> LocationUri? {
    var scheme: String?
    var rest = Substring(value)
    if let schemeRange = value.range(of: "://") {
      // scheme 검증: ALPHA *( ALPHA / DIGIT / + - . )
      let s = String(value[value.startIndex..<schemeRange.lowerBound])
      guard let first = s.unicodeScalars.first, first.properties.isAlphabetic else { return nil }
      let ok = s.unicodeScalars.allSatisfy { sc in
        let v = sc.value
        return (v >= 0x41 && v <= 0x5a) || (v >= 0x61 && v <= 0x7a) || (v >= 0x30 && v <= 0x39)
          || v == 0x2b || v == 0x2d || v == 0x2e
      }
      guard ok else { return nil }
      scheme = s.lowercased()
      rest = value[schemeRange.upperBound...]
    } else {
      return LocationUri(scheme: nil, rawUserInfo: nil, host: nil, port: -1, rawPath: value, rawQuery: nil, rawFragment: nil)
    }

    var fragment: String?
    if let hash = rest.firstIndex(of: "#") {
      fragment = String(rest[rest.index(after: hash)...])
      rest = rest[rest.startIndex..<hash]
    }
    var query: String?
    if let q = rest.firstIndex(of: "?") {
      query = String(rest[rest.index(after: q)...])
      rest = rest[rest.startIndex..<q]
    }
    let authority: Substring
    let path: String
    if let slash = rest.firstIndex(of: "/") {
      authority = rest[rest.startIndex..<slash]
      path = String(rest[slash...])
    } else {
      authority = rest
      path = ""
    }
    var userInfo: String?
    var hostPort = authority
    if let at = authority.lastIndex(of: "@") {
      userInfo = String(authority[authority.startIndex..<at])
      hostPort = authority[authority.index(after: at)...]
    }
    var host: String?
    var port = -1
    if hostPort.hasPrefix("[") {
      guard let close = hostPort.firstIndex(of: "]") else { return nil }
      host = String(hostPort[hostPort.startIndex...close])
      let after = hostPort[hostPort.index(after: close)...]
      if after.hasPrefix(":") {
        port = Int(after.dropFirst()) ?? -2
      } else if !after.isEmpty {
        return nil
      }
    } else if !hostPort.isEmpty {
      if let colon = hostPort.lastIndex(of: ":") {
        host = String(hostPort[hostPort.startIndex..<colon])
        port = Int(hostPort[hostPort.index(after: colon)...]) ?? -2
      } else {
        host = String(hostPort)
      }
    }

    return LocationUri(
      scheme: scheme, rawUserInfo: userInfo, host: host, port: port,
      rawPath: path, rawQuery: query, rawFragment: fragment
    )
  }
}
