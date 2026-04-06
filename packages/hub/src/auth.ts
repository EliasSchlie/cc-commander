import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { HubDb } from "./db.ts";

const SALT_ROUNDS = 10;
const JWT_EXPIRY = "15m";
const REFRESH_EXPIRY_DAYS = 30;

export interface TokenPair {
  token: string;
  refreshToken: string;
}

export interface JwtPayload {
  accountId: string;
  email: string;
}

export class AuthService {
  db: HubDb;
  jwtSecret: string;

  constructor(db: HubDb, jwtSecret: string) {
    this.db = db;
    this.jwtSecret = jwtSecret;
  }

  async register(email: string, password: string): Promise<TokenPair> {
    const existing = this.db.getAccountByEmail(email);
    if (existing) {
      throw new Error("Email already registered");
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const account = this.db.createAccount(email, hash);
    return this.issueTokens(account.id, account.email);
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const account = this.db.getAccountByEmail(email);
    if (!account) {
      throw new Error("Invalid credentials");
    }
    const valid = await bcrypt.compare(password, account.passwordHash);
    if (!valid) {
      throw new Error("Invalid credentials");
    }
    return this.issueTokens(account.id, account.email);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const stored = this.db.getRefreshToken(refreshToken);
    if (!stored) {
      throw new Error("Invalid refresh token");
    }
    if (new Date(stored.expiresAt) < new Date()) {
      this.db.deleteRefreshToken(refreshToken);
      throw new Error("Refresh token expired");
    }
    // Rotate: delete old, issue new
    this.db.deleteRefreshToken(refreshToken);
    const account = this.db.getAccountById(stored.accountId);
    if (!account) {
      throw new Error("Account not found");
    }
    return this.issueTokens(account.id, account.email);
  }

  verifyToken(token: string): JwtPayload {
    const payload = jwt.verify(token, this.jwtSecret) as JwtPayload;
    return { accountId: payload.accountId, email: payload.email };
  }

  private issueTokens(accountId: string, email: string): TokenPair {
    const token = jwt.sign({ accountId, email }, this.jwtSecret, {
      expiresIn: JWT_EXPIRY,
    });
    const expiresAt = new Date(
      Date.now() + REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const refreshToken = this.db.createRefreshToken(accountId, expiresAt);
    return { token, refreshToken };
  }
}
