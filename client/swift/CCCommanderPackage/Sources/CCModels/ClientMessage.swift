import Foundation

/// Messages sent from a device to the hub. Encoded to JSON with a "type" discriminator.
public enum ClientMessage: Sendable {
    case startSession(machineId: String, directory: String, prompt: String)
    case sendPrompt(sessionId: String, prompt: String)
    case respondToPrompt(sessionId: String, promptId: String, response: UserPromptResponse)
    case listSessions
    case getSessionHistory(sessionId: String)
    case listMachines
}

extension ClientMessage: Encodable {
    private enum MessageType: String {
        case startSession = "start_session"
        case sendPrompt = "send_prompt"
        case respondToPrompt = "respond_to_prompt"
        case listSessions = "list_sessions"
        case getSessionHistory = "get_session_history"
        case listMachines = "list_machines"
    }

    private enum CodingKeys: String, CodingKey {
        case type, machineId, directory, prompt, sessionId, promptId, response
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .startSession(let machineId, let directory, let prompt):
            try container.encode(MessageType.startSession.rawValue, forKey: .type)
            try container.encode(machineId, forKey: .machineId)
            try container.encode(directory, forKey: .directory)
            try container.encode(prompt, forKey: .prompt)

        case .sendPrompt(let sessionId, let prompt):
            try container.encode(MessageType.sendPrompt.rawValue, forKey: .type)
            try container.encode(sessionId, forKey: .sessionId)
            try container.encode(prompt, forKey: .prompt)

        case .respondToPrompt(let sessionId, let promptId, let response):
            try container.encode(MessageType.respondToPrompt.rawValue, forKey: .type)
            try container.encode(sessionId, forKey: .sessionId)
            try container.encode(promptId, forKey: .promptId)
            try container.encode(response, forKey: .response)

        case .listSessions:
            try container.encode(MessageType.listSessions.rawValue, forKey: .type)

        case .getSessionHistory(let sessionId):
            try container.encode(MessageType.getSessionHistory.rawValue, forKey: .type)
            try container.encode(sessionId, forKey: .sessionId)

        case .listMachines:
            try container.encode(MessageType.listMachines.rawValue, forKey: .type)
        }
    }
}
