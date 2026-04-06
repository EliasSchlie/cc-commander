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
    private enum CodingKeys: String, CodingKey {
        case type, machineId, directory, prompt, sessionId, promptId, response
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .startSession(let machineId, let directory, let prompt):
            try container.encode("start_session", forKey: .type)
            try container.encode(machineId, forKey: .machineId)
            try container.encode(directory, forKey: .directory)
            try container.encode(prompt, forKey: .prompt)

        case .sendPrompt(let sessionId, let prompt):
            try container.encode("send_prompt", forKey: .type)
            try container.encode(sessionId, forKey: .sessionId)
            try container.encode(prompt, forKey: .prompt)

        case .respondToPrompt(let sessionId, let promptId, let response):
            try container.encode("respond_to_prompt", forKey: .type)
            try container.encode(sessionId, forKey: .sessionId)
            try container.encode(promptId, forKey: .promptId)
            try container.encode(response, forKey: .response)

        case .listSessions:
            try container.encode("list_sessions", forKey: .type)

        case .getSessionHistory(let sessionId):
            try container.encode("get_session_history", forKey: .type)
            try container.encode(sessionId, forKey: .sessionId)

        case .listMachines:
            try container.encode("list_machines", forKey: .type)
        }
    }
}
