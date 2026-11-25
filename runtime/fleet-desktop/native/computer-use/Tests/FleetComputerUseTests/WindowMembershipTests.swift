import CoreGraphics
import Testing
@testable import FleetComputerUse

struct WindowMembershipTests {
  private let target = WindowKey(pid: 100, id: 4778, launched: nil)
  // 대상 창 4778 > 시트 > 분할 그룹 > '삭제' 버튼. 다른 창 4790 > 버튼.
  private let parents = ["delete": "split", "split": "sheet", "sheet": "doc", "other-button": "other", "other": "app", "doc": "app"]
  private func reaches(_ start: String, loop: Bool = false) -> Bool {
    WindowMembership.reaches(start, root: "doc", parent: { loop ? $0 : parents[$0] }, same: ==)
  }

  @Test func acceptsASheetElementWhoseWindowNumberIsTheRemotePanelButWhoseAncestorsReachTheTarget() {
    #expect(WindowMembership.decide(pid: 100, window: 4780, target: target) { reaches("delete") })
  }

  @Test func keepsTheFastPathForElementsReportingTheTargetWindow() {
    #expect(WindowMembership.decide(pid: 100, window: 4778, target: target) { Issue.record("walked"); return false })
  }

  @Test func rejectsAnotherWindowOfTheSameApp() {
    #expect(!WindowMembership.decide(pid: 100, window: 4790, target: target) { reaches("other-button") })
  }

  @Test func rejectsAnotherAppEvenWhenItsChainWouldReachTheRoot() {
    #expect(!WindowMembership.decide(pid: 200, window: 4780, target: target) { Issue.record("walked"); return true })
    #expect(!WindowMembership.decide(pid: nil, window: 4778, target: target) { true })
  }

  @Test func stopsOnParentCycles() {
    #expect(!reaches("delete", loop: true))
  }
}
