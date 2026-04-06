import Foundation
import Security

/// Stores auth tokens in the Keychain (production) or in-memory (tests/previews).
public protocol KeychainStoreProtocol: Sendable {
    func save(key: String, value: String) throws
    func load(key: String) throws -> String?
    func delete(key: String) throws
}

extension KeychainStoreProtocol {
    public var jwt: String? {
        get { try? load(key: "cc-commander-jwt") }
    }

    public var refreshToken: String? {
        get { try? load(key: "cc-commander-refresh") }
    }

    public func saveTokens(jwt: String, refreshToken: String) throws {
        try save(key: "cc-commander-jwt", value: jwt)
        try save(key: "cc-commander-refresh", value: refreshToken)
    }

    public func clearTokens() throws {
        try delete(key: "cc-commander-jwt")
        try delete(key: "cc-commander-refresh")
    }
}

/// Production Keychain wrapper using Security framework.
public struct KeychainStore: KeychainStoreProtocol {
    private let service: String

    public init(service: String = "com.cc-commander.client") {
        self.service = service
    }

    public func save(key: String, value: String) throws {
        guard let data = value.data(using: .utf8) else { return }
        // Delete existing first
        try? delete(key: key)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }

    public func load(key: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            if status == errSecItemNotFound { return nil }
            throw KeychainError.loadFailed(status)
        }
        return String(data: data, encoding: .utf8)
    }

    public func delete(key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.deleteFailed(status)
        }
    }
}

public enum KeychainError: Error, Sendable {
    case saveFailed(OSStatus)
    case loadFailed(OSStatus)
    case deleteFailed(OSStatus)
}

/// In-memory keychain for tests and previews.
public final class MockKeychainStore: KeychainStoreProtocol, @unchecked Sendable {
    private var storage: [String: String] = [:]
    private let lock = NSLock()

    public init() {}

    public func save(key: String, value: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage[key] = value
    }

    public func load(key: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return storage[key]
    }

    public func delete(key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage.removeValue(forKey: key)
    }
}
