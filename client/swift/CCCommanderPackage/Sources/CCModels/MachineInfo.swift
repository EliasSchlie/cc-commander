import Foundation

public struct MachineInfo: Codable, Identifiable, Sendable {
    public let machineId: String
    public let name: String
    public var online: Bool
    public let lastSeen: Date

    public var id: String { machineId }

    public init(machineId: String, name: String, online: Bool, lastSeen: Date) {
        self.machineId = machineId
        self.name = name
        self.online = online
        self.lastSeen = lastSeen
    }
}
