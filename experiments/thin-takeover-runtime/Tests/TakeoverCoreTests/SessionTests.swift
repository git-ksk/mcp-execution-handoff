import Foundation
import Testing
@testable import TakeoverCore

@Test func authorityIsExclusiveAndEpochFenced() async throws {
    let controller = TakeoverSessionController()
    let binding = TakeoverBinding(interventionID: UUID(), principalID: "operator", epoch: 10, generation: 1)
    try await controller.grantHuman(binding)
    #expect(await controller.currentAuthority() == .human(binding))
    let next = try await controller.revokeHuman(binding)
    #expect(next == 11)
    try await controller.resumeAgent(expectedEpoch: 11)
    #expect(await controller.currentAuthority() == .agent)
}

@Test func agentCannotResumeBeforeHumanRevocation() async throws {
    let controller = TakeoverSessionController()
    let binding = TakeoverBinding(interventionID: UUID(), principalID: "operator", epoch: 10, generation: 1)
    try await controller.grantHuman(binding)

    do {
        try await controller.resumeAgent(expectedEpoch: 10)
        Issue.record("agent resume unexpectedly succeeded while Human authority remained active")
    } catch {
        #expect(error as? TakeoverSessionError == .humanStillActive)
    }

    #expect(await controller.currentAuthority() == .human(binding))
}
