import Foundation
import Security
import CryptoKit

// RemoteConnection.kt CertificatePolicy의 이식. 원격 콘솔의 leaf 인증서를 시스템 CA가 아니라
// 핀으로만 신뢰한다: 유효기간 통과, leaf(CA 아님), 호스트명과 정확히 일치하는 SAN(IP면
// iPAddress, 이름이면 dNSName), 그리고 SHA-256 지문이 저장된 핀과 정확히 일치.
// SecCertificate 필드는 iOS에 SecCertificateCopyValues가 없어 DER을 직접 파싱한다(CertFields).

public struct CertificateError: Error, Equatable {
  public let code: String
  public init(_ code: String) { self.code = code }
}

public enum CertificatePolicy {
  public static func verifyLeaf(_ certificate: SecCertificate, _ target: PersistedTarget, now: Date = Date()) throws {
    let der = SecCertificateCopyData(certificate) as Data
    guard let fields = CertFields.parse([UInt8](der)) else { throw CertificateError("certificate_not_leaf") }
    guard let notBefore = fields.notBefore, let notAfter = fields.notAfter else {
      throw CertificateError("certificate_not_leaf")
    }
    if now > notAfter { throw CertificateError("certificate_expired") }
    if now < notBefore { throw CertificateError("certificate_not_yet_valid") }
    if !fields.isLeaf { throw CertificateError("certificate_not_leaf") }
    if !hasExactSubjectAlternativeName(fields, target.hostname) { throw CertificateError("certificate_hostname_mismatch") }
    if fingerprint(certificate) != target.fingerprint { throw CertificateError("certificate_pin_mismatch") }
  }

  // internal: 파라미터 CertFields가 internal이므로 public일 수 없다. verifyLeaf가 내부에서 쓴다.
  static func hasExactSubjectAlternativeName(_ fields: CertFields, _ hostname: String) -> Bool {
    if isIpLiteral(hostname) {
      guard let ip = LocalTlsIdentity.ipAddressBytes(hostname) else { return false }
      return fields.ipSans.contains(ip)
    }
    return fields.dnsSans.contains { $0.caseInsensitiveCompare(hostname) == .orderedSame }
  }

  public static func isIpLiteral(_ host: String) -> Bool {
    if host.contains(":") { return true }
    guard matchesFull("^(?:0|[1-9]\\d{0,2})(?:\\.(?:0|[1-9]\\d{0,2})){3}$", host) else { return false }
    return host.split(separator: ".").allSatisfy { (Int($0) ?? -1) >= 0 && (Int($0) ?? 256) <= 255 }
  }

  public static func fingerprint(_ certificate: SecCertificate) -> String {
    let der = SecCertificateCopyData(certificate) as Data
    return SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined()
  }

  private static func matchesFull(_ pattern: String, _ input: String) -> Bool {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
    let range = NSRange(input.startIndex..<input.endIndex, in: input)
    guard let m = regex.firstMatch(in: input, options: [], range: range) else { return false }
    return m.range == range
  }
}
