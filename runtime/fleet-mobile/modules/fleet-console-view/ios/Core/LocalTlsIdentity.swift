import Foundation
import Security

// LoopbackGateway.kt LocalTlsIdentity / LocalCertificatePolicy의 이식.
// Android는 BouncyCastle로 자체서명 인증서를 만들지만 Security.framework에는 인증서 빌더가
// 없으므로 ASN.1 DER을 직접 조립한다: P-256 키, CN=host, 랜덤 160비트 시리얼, notBefore
// now-60s / notAfter +24h, basicConstraints CA:false(critical), SAN iPAddress=host(non-critical),
// SHA256withECDSA 서명. iOS 추가: KeyUsage digitalSignature(critical) — iPadOS 18.4가
// digitalSignature 없는 로컬 인증서를 WKWebView에서 거부한 회귀 대응.
//
// matches는 iOS에서 SecCertificateCopyValues가 없으므로 DER을 직접 파싱해 SAN/유효기간/leaf를
// 확인한다. 이 파일의 런타임 TLS 동작(실제 서버 identity, 핀 검증)은 기기에서만 검증된다
// [Unverified-on-device]; CI는 encode+parse 왕복(matches 테스트)만 증명한다.

public struct LocalTlsIdentity {
  public let certificate: SecCertificate
  public let privateKey: SecKey
  public let certificateDer: Data

  public enum CreateError: Error { case keyGeneration(String); case signing(String); case encoding(String) }

  public static func create(_ host: String, now: Date = Date()) throws -> LocalTlsIdentity {
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
    ]
    var error: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw CreateError.keyGeneration(String(describing: error?.takeRetainedValue()))
    }
    guard let publicKey = SecKeyCopyPublicKey(privateKey),
          let pubData = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw CreateError.keyGeneration("public key export failed")
    }
    // pubData는 ANSI X9.63 비압축 점(0x04 || X || Y), P-256이면 65바이트 → SPKI BIT STRING 내용.

    let tbs = try buildTbsCertificate(host: host, now: now, publicKeyPoint: [UInt8](pubData))
    // ECDSA(SHA-256) 서명, 결과는 X9.62 DER(SEQUENCE{r,s}) → signatureValue BIT STRING 내용.
    guard let signature = SecKeyCreateSignature(
      privateKey, .ecdsaSignatureMessageX962SHA256, Data(tbs) as CFData, &error) as Data? else {
      throw CreateError.signing(String(describing: error?.takeRetainedValue()))
    }
    let certDer = Der.sequence(
      tbs
        + Der.algIdentifier(Der.OID.ecdsaWithSHA256)
        + Der.bitString([UInt8](signature))
    )
    guard let certificate = SecCertificateCreateWithData(nil, Data(certDer) as CFData) else {
      throw CreateError.encoding("SecCertificateCreateWithData rejected the DER")
    }
    return LocalTlsIdentity(certificate: certificate, privateKey: privateKey, certificateDer: Data(certDer))
  }

  private static func buildTbsCertificate(host: String, now: Date, publicKeyPoint: [UInt8]) throws -> [UInt8] {
    let version = Der.explicit(0, Der.integer([2])) // v3
    let serial = Der.integerPositive(randomBytes(20))
    let sigAlg = Der.algIdentifier(Der.OID.ecdsaWithSHA256)
    let name = Der.name(commonName: host)
    let validity = Der.sequence(Der.utcTime(now.addingTimeInterval(-60)) + Der.utcTime(now.addingTimeInterval(24 * 60 * 60)))
    let spki = Der.subjectPublicKeyInfoEC(point: publicKeyPoint)

    guard let ipBytes = Self.ipAddressBytes(host) else { throw CreateError.encoding("host is not an IP literal: \(host)") }
    let extensions = Der.explicit(3, Der.sequence(
      Der.extensionEntry(oid: Der.OID.basicConstraints, critical: true, value: Der.sequence([])) // CA 부재 = false
        + Der.extensionEntry(oid: Der.OID.keyUsage, critical: true, value: Der.keyUsageDigitalSignature())
        + Der.extensionEntry(oid: Der.OID.subjectAltName, critical: false, value: Der.subjectAltNameIP(ipBytes))
    ))

    return Der.sequence(version + serial + sigAlg + name + validity + name + spki + extensions)
  }

  private static func randomBytes(_ count: Int) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: count)
    _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    return bytes
  }

  /// TLS 서버 identity. SecIdentity는 키체인을 통해서만 얻을 수 있으므로 키·인증서를
  /// 임시 태그로 등재해 조회하고, 게이트웨이 종료 시 removeFromKeychain으로 지운다.
  /// 앱 프라이빗 키체인이며 단명 인증서(24h)라 잔존해도 위험은 낮지만 지운다.
  public func secIdentity() throws -> SecIdentity {
    let tag = Data("fleet-mobile-loopback-\(UUID().uuidString)".utf8)
    let keyAdd: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecValueRef as String: privateKey,
      kSecAttrApplicationTag as String: tag,
    ]
    let keyStatus = SecItemAdd(keyAdd as CFDictionary, nil)
    guard keyStatus == errSecSuccess || keyStatus == errSecDuplicateItem else {
      throw CreateError.encoding("keychain key add failed: \(keyStatus)")
    }
    let certAdd: [String: Any] = [
      kSecClass as String: kSecClassCertificate,
      kSecValueRef as String: certificate,
    ]
    let certStatus = SecItemAdd(certAdd as CFDictionary, nil)
    guard certStatus == errSecSuccess || certStatus == errSecDuplicateItem else {
      throw CreateError.encoding("keychain cert add failed: \(certStatus)")
    }
    // 우리 인증서와 DER이 정확히 일치하는 identity를 찾는다.
    let query: [String: Any] = [
      kSecClass as String: kSecClassIdentity,
      kSecReturnRef as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let identities = result as? [SecIdentity] else {
      throw CreateError.encoding("keychain identity query failed: \(status)")
    }
    for identity in identities {
      var certRef: SecCertificate?
      if SecIdentityCopyCertificate(identity, &certRef) == errSecSuccess,
         let certRef, (SecCertificateCopyData(certRef) as Data) == certificateDer {
        return identity
      }
    }
    throw CreateError.encoding("keychain identity not found for the loopback certificate")
  }

  /// 게이트웨이 종료 시 임시 키체인 항목을 지운다(베스트 에포트).
  public func removeFromKeychain() {
    let certDelete: [String: Any] = [
      kSecClass as String: kSecClassCertificate,
      kSecValueRef as String: certificate,
    ]
    SecItemDelete(certDelete as CFDictionary)
    let keyDelete: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecValueRef as String: privateKey,
    ]
    SecItemDelete(keyDelete as CFDictionary)
  }

  // IPv4 점표기 → 4바이트, IPv6 → 16바이트. 아니면 nil.
  static func ipAddressBytes(_ host: String) -> [UInt8]? {
    var v4 = in_addr()
    if inet_pton(AF_INET, host, &v4) == 1 {
      return withUnsafeBytes(of: &v4.s_addr) { Array($0) }
    }
    var v6 = in6_addr()
    if inet_pton(AF_INET6, host, &v6) == 1 {
      return withUnsafeBytes(of: &v6) { Array($0) }
    }
    return nil
  }
}

// LocalCertificatePolicy: 제시된 인증서를 정확히 하나의 로컬 인증서로만 신뢰한다 —
// 유효기간 통과, leaf(CA 아님), DER 바이트 정확 일치, SAN이 host를 정확히 포함.
public enum LocalCertificatePolicy {
  public static func matches(_ presented: SecCertificate, _ expected: SecCertificate, _ host: String, now: Date = Date()) -> Bool {
    let presentedDer = SecCertificateCopyData(presented) as Data
    let expectedDer = SecCertificateCopyData(expected) as Data
    guard presentedDer == expectedDer else { return false }
    guard let parsed = CertFields.parse([UInt8](presentedDer)) else { return false }
    guard let notBefore = parsed.notBefore, let notAfter = parsed.notAfter else { return false }
    guard now >= notBefore && now <= notAfter else { return false }
    guard parsed.isLeaf else { return false }
    guard let ip = LocalTlsIdentity.ipAddressBytes(host) else { return false }
    return parsed.ipSans.contains(ip)
  }
}
