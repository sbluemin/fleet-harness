import Foundation

// 이 파일이 iOS 포팅의 교차 파일 타입 계약 원본이다 — 시그니처를 바꾸려면 여기를 먼저
// 바꾸고 소비자를 따라 바꾼다. 각 구현 파일은 자신이 이식한 Android 원본 파일을 머리에
// 적고, 행동 규칙(정규식·한계값·에러 코드)은 그 원본에서 리터럴로 복사한다.

/// TargetStore.kt LoopbackIdentity의 이식. Android는 타깃마다 랜덤 127.x.y.z 주소를 쓰지만
/// iOS 기기는 127.0.0.1 외 루프백 주소를 바인딩할 수 없으므로(EADDRNOTAVAIL) host는 항상
/// 127.0.0.1이고, 타깃 격리는 랜덤 포트가 담당한다. 웹 오리진은 scheme://host:port 단위라
/// 오리진 격리 자체는 유지된다.
public struct LoopbackIdentity: Equatable, Codable, Sendable {
  public let host: String
  public let port: Int

  public init(host: String, port: Int) {
    self.host = host
    self.port = port
  }

  public var origin: String { "https://\(host):\(port)" }
}

/// AccessLink.kt AccessTarget의 이식 — 파싱 직후의, 아직 크리덴셜(token)을 들고 있는 타깃.
public struct AccessTarget: Equatable, Sendable {
  public let origin: String
  public let hostname: String
  public let port: Int
  public let label: String
  public let token: String
  public let fingerprint: String

  public init(origin: String, hostname: String, port: Int, label: String, token: String, fingerprint: String) {
    self.origin = origin
    self.hostname = hostname
    self.port = port
    self.label = label
    self.token = token
    self.fingerprint = fingerprint
  }

  public var consoleUrl: String { "\(origin)/console/" }
  public var joinUrl: String { "\(origin)/api/v1/join" }

  /// 영속화 시 페어링 토큰을 떨어뜨린다 — 크리덴셜은 절대 디스크에 남지 않는다.
  public func withoutCredential(_ identity: LoopbackIdentity) -> PersistedTarget {
    PersistedTarget(origin: origin, hostname: hostname, port: port, label: label, fingerprint: fingerprint, loopback: identity)
  }
}

/// AccessLink.kt PersistedTarget의 이식 — 저장되는 것은 "어디로 갈지와 어떤 인증서를 믿을지"
/// 뿐이고 크리덴셜은 없다.
public struct PersistedTarget: Equatable, Codable, Sendable {
  public let origin: String
  public let hostname: String
  public let port: Int
  public let label: String
  public let fingerprint: String
  public let loopback: LoopbackIdentity

  public init(origin: String, hostname: String, port: Int, label: String, fingerprint: String, loopback: LoopbackIdentity) {
    self.origin = origin
    self.hostname = hostname
    self.port = port
    self.label = label
    self.fingerprint = fingerprint
    self.loopback = loopback
  }

  public var consoleUrl: String { "\(origin)/console/" }
  public var joinUrl: String { "\(origin)/api/v1/join" }
  public var readinessUrl: String { "\(origin)/api/v1/status" }

  /// LoopbackGateway.kt PersistedTarget.authority의 이식 — Host 헤더용 authority.
  /// IPv6는 브래킷, 443은 생략.
  public var authority: String {
    let host = hostname.contains(":") ? "[\(hostname)]" : hostname
    return port == 443 ? host : "\(host):\(port)"
  }
}

/// RemoteConnection.kt ConnectionFailure의 이식. 네이티브→JS 에러 계약은 HTTP 상태가 아니라
/// 이 code 문자열이며, 코드 목록은 App.tsx describe()가 소비하는 것과 정확히 같아야 한다.
public struct ConnectionFailure: Error, Sendable {
  public let code: String
  public let retryAfterSeconds: Int?

  public init(_ code: String, retryAfterSeconds: Int? = nil) {
    self.code = code
    self.retryAfterSeconds = retryAfterSeconds
  }
}

/// RemoteConnection.kt RetryAfterHeader의 이식 — delta-seconds 0..86400만 신뢰하고
/// HTTP-date나 범위 밖 값은 카운트다운을 만들지 않는다.
public enum RetryAfterHeader {
  public static func seconds(_ value: String?) -> Int? {
    guard
      let trimmed = value?.trimmingCharacters(in: .whitespaces),
      let parsed = Int64(trimmed),
      parsed >= 0, parsed <= 86_400
    else { return nil }
    return Int(parsed)
  }
}

/// 게이트웨이 HTTP 헤더의 순서 보존 멀티맵. 이름 비교는 대소문자 무시(RFC 9110).
public struct Header: Equatable, Sendable {
  public let name: String
  public let value: String

  public init(name: String, value: String) {
    self.name = name
    self.value = value
  }
}

public struct Headers: Equatable, Sendable {
  public private(set) var entries: [Header]

  public init(_ entries: [Header] = []) {
    self.entries = entries
  }

  public func first(_ name: String) -> String? {
    entries.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.value
  }

  public func values(_ name: String) -> [String] {
    entries.filter { $0.name.caseInsensitiveCompare(name) == .orderedSame }.map(\.value)
  }

  public mutating func append(name: String, value: String) {
    entries.append(Header(name: name, value: value))
  }
}

/// RemoteConnection.kt FleetCookieSnapshot의 이식 — 원격 오리진 쿠키의 이름→값 스냅샷.
public struct FleetCookieSnapshot: Equatable, Codable, Sendable {
  public let values: [String: String]

  public init(values: [String: String]) {
    self.values = values
  }
}

/// 게이트웨이와 코덱이 실제 소켓과 테스트 픽스처를 같은 코드로 다루기 위한 블로킹 바이트 IO.
/// LoopbackGateway가 NWConnection 어댑터를 제공하고, 테스트는 바이트 배열 구현을 쓴다.
public protocol ByteInput: AnyObject {
  /// 최대 maxLength 바이트를 블로킹으로 읽는다. 빈 배열이 EOF다.
  func read(_ maxLength: Int) throws -> [UInt8]
  /// nil이면 읽기 타임아웃 해제 — SSE와 WebSocket 릴레이가 쓴다.
  func setReadTimeout(milliseconds: Int?)
}

public protocol ByteOutput: AnyObject {
  func write(_ bytes: [UInt8]) throws
  func flush() throws
}
