import Foundation

// RemoteConnection.kt FleetCookiePolicy의 이식. 원격 콘솔 쿠키를 정확한 호스트/콘솔 포트로
// 스코핑하고, Set-Cookie를 엄격히 검증(HttpOnly/Secure/SameSite=Strict/Path=/, Max-Age는
// pairing만)하며, 스냅샷 롤백을 만든다. 규칙은 원본에서 리터럴로 복사했다.
// FleetCookieStore(CookieManager 연동, Task 6/WKHTTPCookieStore)는 여기 포함하지 않는다.

public struct FleetCookieError: Error, Equatable {
  public let reason: String
  public init(_ reason: String = "invalid_cookie") { self.reason = reason }
}

public enum FleetCookiePolicy {
  private static let valuePattern = "^[A-Za-z0-9_-]*$"

  public static func requestHeader(_ header: String?, _ port: Int) throws -> String? {
    let pairs = try scopedPairs(header, port)
    try require(pairs.allSatisfy { matches(valuePattern, $0.value) })
    let joined = pairs.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    return joined.isEmpty ? nil : joined
  }

  public static func snapshot(_ header: String?, _ port: Int) throws -> FleetCookieSnapshot {
    let pairs = try scopedPairs(header, port)
    try require(pairs.allSatisfy { matches(valuePattern, $0.value) })
    var map: [String: String] = [:]
    for p in pairs { map[p.name] = p.value }
    return FleetCookieSnapshot(values: map)
  }

  public static func restoreHeaders(_ snapshot: FleetCookieSnapshot, _ currentHeader: String?, _ port: Int) throws -> [String] {
    let currentNames = Set(try scopedPairs(currentHeader, port).map { $0.name })
    let expired = currentNames.subtracting(snapshot.values.keys).map {
      "\($0)=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/"
    }
    let restored = snapshot.values.map { (name, value) -> String in
      let maxAge = name == pairingName(port) ? "; Max-Age=31536000" : ""
      return "\(name)=\(value)\(maxAge); Secure; HttpOnly; SameSite=Strict; Path=/"
    }
    return expired + restored
  }

  public static func validateSetCookieHeaders(_ values: [String], _ port: Int) throws -> [String] {
    var seen = Set<String>()
    var out: [String] = []
    for value in values {
      let parts = value.split(separator: ";", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
      let pair = (parts.first ?? "").split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
      try require(pair.count == 2 && names(port).contains(pair[0]) && seen.insert(pair[0]).inserted && matches(valuePattern, pair[1]))
      let cookieName = pair[0]
      let cookieValue = pair[1]

      var attrNames = Set<String>()
      var attrValues: [String: String] = [:]
      for raw in parts.dropFirst() {
        let attribute = raw.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let name = attribute[0].lowercased()
        try require(["httponly", "secure", "samesite", "path", "max-age"].contains(name) && !attrNames.contains(name))
        attrNames.insert(name)
        if attribute.count > 1 { attrValues[name] = attribute[1] }
      }
      // HttpOnly/Secure는 값 없는 플래그로 존재해야 한다.
      try require(attrNames.contains("httponly") && attrValues["httponly"] == nil)
      try require(attrNames.contains("secure") && attrValues["secure"] == nil)
      try require(attrValues["samesite"]?.caseInsensitiveCompare("Strict") == .orderedSame)
      try require(attrValues["path"] == "/")
      let maxAge = attrValues["max-age"]
      // max-age가 있으면 값이 있어야 하고 0 이상 정수여야 한다(플래그 Max-Age는 거부).
      if attrNames.contains("max-age") {
        try require(maxAge != nil && (Int64(maxAge!).map { $0 >= 0 } ?? false))
      }
      // Max-Age는 pairing 쿠키에만 허용.
      try require(maxAge == nil || cookieName == pairingName(port))
      // 값이 비었으면 Max-Age=0(삭제)일 때만 허용.
      try require(!cookieValue.isEmpty || maxAge == "0")

      var normalized = "\(cookieName)=\(cookieValue)"
      if let maxAge { normalized += "; Max-Age=\(maxAge)" }
      normalized += "; Secure; HttpOnly; SameSite=Strict; Path=/"
      out.append(normalized)
    }
    return out
  }

  // MARK: - Helpers

  private static func names(_ port: Int) -> Set<String> { [sessionName(port), pairingName(port)] }
  private static func sessionName(_ port: Int) -> String { "fleet_console_session_\(port)" }
  private static func pairingName(_ port: Int) -> String { "fleet_console_pairing_\(port)" }

  // 순서 보존이 필요한 곳(requestHeader)을 위해 Map이 아니라 배열로 반환한다.
  private static func scopedPairs(_ header: String?, _ port: Int) throws -> [(name: String, value: String)] {
    let pairs = parse(header).filter { names(port).contains($0.name) }
    try require(Set(pairs.map { $0.name }).count == pairs.count)
    return pairs
  }

  private static func parse(_ header: String?) -> [(name: String, value: String)] {
    (header ?? "").split(separator: ";", omittingEmptySubsequences: false).compactMap { piece in
      let pair = piece.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      if pair.count == 2 && !pair[0].isEmpty { return (String(pair[0]), String(pair[1])) }
      return nil
    }
  }

  private static func matches(_ pattern: String, _ input: String) -> Bool {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
    let range = NSRange(input.startIndex..<input.endIndex, in: input)
    guard let m = regex.firstMatch(in: input, options: [], range: range) else { return false }
    return m.range == range
  }

  private static func require(_ condition: Bool) throws {
    if !condition { throw FleetCookieError() }
  }
}
