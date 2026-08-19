import Dispatch

public enum MonotonicClock {
    @inline(__always)
    public static func nowNanos() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds
    }
}
