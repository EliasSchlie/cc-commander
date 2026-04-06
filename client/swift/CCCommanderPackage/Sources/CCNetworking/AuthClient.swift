import Foundation

/// Token pair returned by auth endpoints.
public struct TokenPair: Codable, Sendable {
    public let token: String
    public let refreshToken: String

    public init(token: String, refreshToken: String) {
        self.token = token
        self.refreshToken = refreshToken
    }
}

/// REST auth client. Login/register/refresh via HTTP POST.
public protocol AuthClientProtocol: Sendable {
    func login(email: String, password: String) async throws -> TokenPair
    func register(email: String, password: String) async throws -> TokenPair
    func refresh(refreshToken: String) async throws -> TokenPair
}

/// Production auth client using URLSession.
public struct AuthClient: AuthClientProtocol {
    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func login(email: String, password: String) async throws -> TokenPair {
        try await post(path: "/api/auth/login", body: AuthRequest(email: email, password: password))
    }

    public func register(email: String, password: String) async throws -> TokenPair {
        try await post(path: "/api/auth/register", body: AuthRequest(email: email, password: password))
    }

    public func refresh(refreshToken: String) async throws -> TokenPair {
        try await post(path: "/api/auth/refresh", body: RefreshRequest(refreshToken: refreshToken))
    }

    private func post<T: Encodable>(path: String, body: T) async throws -> TokenPair {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AuthError.invalidResponse
        }
        guard http.statusCode == 200 else {
            let errorBody = try? JSONDecoder().decode(AuthErrorResponse.self, from: data)
            throw AuthError.serverError(http.statusCode, errorBody?.error ?? "Unknown error")
        }
        return try JSONDecoder().decode(TokenPair.self, from: data)
    }
}

private struct AuthRequest: Encodable {
    let email: String
    let password: String
}

private struct RefreshRequest: Encodable {
    let refreshToken: String
}

private struct AuthErrorResponse: Decodable {
    let error: String
}

public enum AuthError: Error, Sendable, LocalizedError {
    case invalidResponse
    case serverError(Int, String)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse: return "Invalid server response"
        case .serverError(_, let msg): return msg
        }
    }
}

/// Mock auth client for tests and previews.
public actor MockAuthClient: AuthClientProtocol {
    public var loginResult: Result<TokenPair, Error> = .success(TokenPair(token: "mock-jwt", refreshToken: "mock-refresh"))
    public var registerResult: Result<TokenPair, Error> = .success(TokenPair(token: "mock-jwt", refreshToken: "mock-refresh"))
    public var refreshResult: Result<TokenPair, Error> = .success(TokenPair(token: "mock-jwt-refreshed", refreshToken: "mock-refresh-2"))
    public private(set) var loginCallCount = 0
    public private(set) var refreshCallCount = 0

    public init() {}

    public func login(email: String, password: String) async throws -> TokenPair {
        loginCallCount += 1
        return try loginResult.get()
    }

    public func register(email: String, password: String) async throws -> TokenPair {
        return try registerResult.get()
    }

    public func refresh(refreshToken: String) async throws -> TokenPair {
        refreshCallCount += 1
        return try refreshResult.get()
    }
}
