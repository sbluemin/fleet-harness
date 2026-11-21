// mac-helper 미션이 채운다: stdio 프로토콜, AX 스냅숏, 이벤트 전송, 캡처, 자가 점검.
import AppKit

enum HelperMain {
  static func run(arguments: [String]) {
    // 자리 표시: 프로토콜 구현 전까지 hello에만 응답하지 않고 종료한다.
    FileHandle.standardError.write("fleet-computer-use: helper not implemented yet\n".data(using: .utf8)!)
    exit(2)
  }
}
