import Testing
@testable import TakeoverCore

@Test func ephemeralLeaseExpiresAndRevokes() throws {
    let lease = try EphemeralLeaseFactory.make(
        expiresAtUnixMillis: 2_000,
        nowUnixMillis: 1_000,
        nowMonotonicNanos: 5_000
    )
    #expect(lease.isActive(nowNanos: 5_000))
    #expect(lease.isActive(nowNanos: 999_999_999))
    #expect(!lease.isActive(nowNanos: 1_000_005_000))

    let other = EphemeralSessionLease(deadlineNanos: 10_000)
    #expect(other.isActive(nowNanos: 1))
    other.revoke()
    #expect(!other.isActive(nowNanos: 2))
}

@Test func ephemeralLeaseRejectsExpiredGrant() {
    do {
        _ = try EphemeralLeaseFactory.make(
            expiresAtUnixMillis: 1_000,
            nowUnixMillis: 1_000,
            nowMonotonicNanos: 1
        )
        Issue.record("expired lease unexpectedly succeeded")
    } catch {
        #expect(error as? EphemeralLeaseError == .alreadyExpired)
    }
}
