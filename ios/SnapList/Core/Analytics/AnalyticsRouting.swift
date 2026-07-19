enum AnalyticsRuntimeMode: Equatable, Sendable {
    case disabled
    case debug
}

struct AnalyticsRuntimeConfiguration: Equatable, Sendable {
    let metadata: AnalyticsMetadata
    let mode: AnalyticsRuntimeMode

    init?(
        environment: AnalyticsEnvironment,
        metadata: AnalyticsMetadata,
        mode: AnalyticsRuntimeMode
    ) {
        guard environment == metadata.environment else { return nil }
        self.metadata = metadata
        self.mode = mode
    }
}
