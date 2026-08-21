import Foundation

public struct TakeoverBinding: Sendable, Equatable {
    public let interventionID: UUID
    public let principalID: String
    public let epoch: UInt64
    public let generation: UInt32

    public init(interventionID: UUID, principalID: String, epoch: UInt64, generation: UInt32) {
        self.interventionID = interventionID
        self.principalID = principalID
        self.epoch = epoch
        self.generation = generation
    }
}

public enum TakeoverAuthority: Sendable, Equatable {
    case agent
    case human(TakeoverBinding)
    case revoked(lastEpoch: UInt64)
}

public enum TakeoverSessionError: Error, Equatable {
    case alreadyHumanOwned
    case notHumanOwned
    case bindingMismatch
    case staleEpoch
    case humanStillActive
}

public actor TakeoverSessionController {
    private var authority: TakeoverAuthority = .agent
    private var highestEpoch: UInt64 = 0

    public init() {}

    public func currentAuthority() -> TakeoverAuthority { authority }

    public func grantHuman(_ binding: TakeoverBinding) throws {
        guard binding.epoch >= highestEpoch else { throw TakeoverSessionError.staleEpoch }
        if case .human = authority { throw TakeoverSessionError.alreadyHumanOwned }
        highestEpoch = binding.epoch
        authority = .human(binding)
    }

    public func validateHuman(_ binding: TakeoverBinding) throws {
        guard case let .human(active) = authority else { throw TakeoverSessionError.notHumanOwned }
        guard active == binding else { throw TakeoverSessionError.bindingMismatch }
    }

    @discardableResult
    public func revokeHuman(_ binding: TakeoverBinding) throws -> UInt64 {
        try validateHuman(binding)
        let nextEpoch = max(highestEpoch, binding.epoch) &+ 1
        highestEpoch = nextEpoch
        authority = .revoked(lastEpoch: nextEpoch)
        return nextEpoch
    }

    public func resumeAgent(expectedEpoch: UInt64) throws {
        guard expectedEpoch == highestEpoch else { throw TakeoverSessionError.staleEpoch }
        if case .human = authority { throw TakeoverSessionError.humanStillActive }
        authority = .agent
    }
}
