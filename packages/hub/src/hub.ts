import { WebSocketServer, WebSocket } from 'ws'
import { createServer, IncomingMessage } from 'node:http'
import { URL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parseMessage, serializeMessage } from '@cc-commander/shared'
import type {
  DeviceToHubMsg,
  MachineToHubMsg,
  HubToMachineMsg,
  HubToDeviceMsg,
  RespondToPromptMsg,
  SessionStatus
} from '@cc-commander/shared'
import type { HubDb, MachineRow } from './db.ts'
import type { AuthService, JwtPayload } from './auth.ts'

interface DeviceConnection {
  ws: WebSocket
  accountId: string
  email: string
}

interface MachineConnection {
  ws: WebSocket
  machineId: string
  accountId: string
  machineName: string
}

export interface HubConfig {
  port: number
  db: HubDb
  auth: AuthService
}

export class Hub {
  config: HubConfig
  devices: Map<string, DeviceConnection> // connectionId -> connection
  machines: Map<string, MachineConnection> // machineId -> connection
  httpServer: ReturnType<typeof createServer>
  wss: WebSocketServer

  constructor(config: HubConfig) {
    this.config = config
    this.devices = new Map()
    this.machines = new Map()

    this.httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    })

    this.wss = new WebSocketServer({ server: this.httpServer })
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, () => resolve())
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Close all WebSocket connections
      for (const [, conn] of this.devices) {
        conn.ws.close()
      }
      for (const [, conn] of this.machines) {
        conn.ws.close()
      }
      this.wss.close(() => {
        this.httpServer.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    })
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || '/', `http://localhost:${this.config.port}`)
    const path = url.pathname

    if (path === '/ws/device') {
      this.handleDeviceConnection(ws, url)
    } else if (path === '/ws/machine') {
      this.handleMachineConnection(ws, url)
    } else {
      ws.close(4000, 'Unknown endpoint')
    }
  }

  // ── Device connections ──────────────────────────────────────────────

  private handleDeviceConnection(ws: WebSocket, url: URL): void {
    const token = url.searchParams.get('token')
    if (!token) {
      ws.close(4001, 'Missing token')
      return
    }

    let payload: JwtPayload
    try {
      payload = this.config.auth.verifyToken(token)
    } catch {
      ws.close(4001, 'Invalid token')
      return
    }

    const connectionId = randomUUID()
    const conn: DeviceConnection = {
      ws,
      accountId: payload.accountId,
      email: payload.email
    }
    this.devices.set(connectionId, conn)

    // Send initial state to the newly connected device
    this.handleListSessions(conn)
    this.handleListMachines(conn)

    ws.on('message', (data) => {
      try {
        const msg = parseMessage<DeviceToHubMsg>(data.toString())
        this.handleDeviceMessage(conn, msg)
      } catch (err) {
        this.sendToDevice(conn, {
          type: 'error',
          message: err instanceof Error ? err.message : 'Unknown error'
        })
      }
    })

    ws.on('close', () => {
      this.devices.delete(connectionId)
    })
  }

  private handleDeviceMessage(conn: DeviceConnection, msg: DeviceToHubMsg): void {
    switch (msg.type) {
      case 'list_sessions':
        this.handleListSessions(conn)
        break
      case 'list_machines':
        this.handleListMachines(conn)
        break
      case 'start_session':
        this.handleStartSession(conn, msg)
        break
      case 'send_prompt':
        this.handleSendPrompt(conn, msg)
        break
      case 'respond_to_prompt':
        this.handleRespondToPrompt(conn, msg)
        break
      case 'get_session_history':
        this.handleGetSessionHistory(conn, msg)
        break
    }
  }

  private handleListSessions(conn: DeviceConnection): void {
    const sessions = this.config.db.listSessionsForAccount(conn.accountId)
    this.sendToDevice(conn, { type: 'session_list', sessions })
  }

  private handleListMachines(conn: DeviceConnection): void {
    const machines = this.config.db.listMachinesForAccount(conn.accountId)
    // Mark online machines
    for (const m of machines) {
      m.online = this.machines.has(m.machineId)
    }
    this.sendToDevice(conn, { type: 'machine_list', machines })
  }

  private handleStartSession(
    conn: DeviceConnection,
    msg: { machineId: string; directory: string; prompt: string }
  ): void {
    const machineConn = this.machines.get(msg.machineId)
    if (!machineConn) {
      this.sendToDevice(conn, { type: 'error', message: 'Machine is offline' })
      return
    }

    // Verify machine belongs to this account
    if (machineConn.accountId !== conn.accountId) {
      this.sendToDevice(conn, { type: 'error', message: 'Machine not found' })
      return
    }

    const session = this.config.db.createSession(
      conn.accountId,
      msg.machineId,
      msg.directory,
      'running'
    )

    this.sendToMachine(machineConn, {
      type: 'hub_start_session',
      sessionId: session.id,
      directory: msg.directory,
      prompt: msg.prompt
    })

    // Send updated session list to all devices for this account
    this.broadcastSessionList(conn.accountId)
  }

  private handleSendPrompt(
    conn: DeviceConnection,
    msg: { sessionId: string; prompt: string }
  ): void {
    const session = this.config.db.getSessionById(msg.sessionId)
    if (!session || session.accountId !== conn.accountId) {
      this.sendToDevice(conn, { type: 'error', message: 'Session not found' })
      return
    }

    const machineConn = this.machines.get(session.machineId)
    if (!machineConn) {
      this.sendToDevice(conn, { type: 'error', message: 'Machine is offline' })
      return
    }

    this.config.db.updateSessionStatus(session.id, 'running')

    this.sendToMachine(machineConn, {
      type: 'hub_send_prompt',
      sessionId: msg.sessionId,
      prompt: msg.prompt
    })
  }

  private handleRespondToPrompt(conn: DeviceConnection, msg: RespondToPromptMsg): void {
    const session = this.config.db.getSessionById(msg.sessionId)
    if (!session || session.accountId !== conn.accountId) {
      this.sendToDevice(conn, { type: 'error', message: 'Session not found' })
      return
    }

    const machineConn = this.machines.get(session.machineId)
    if (!machineConn) {
      this.sendToDevice(conn, { type: 'error', message: 'Machine is offline' })
      return
    }

    this.sendToMachine(machineConn, {
      type: 'hub_respond_to_prompt',
      sessionId: msg.sessionId,
      promptId: msg.promptId,
      response: msg.response
    })
  }

  private handleGetSessionHistory(conn: DeviceConnection, msg: { sessionId: string }): void {
    const session = this.config.db.getSessionById(msg.sessionId)
    if (!session || session.accountId !== conn.accountId) {
      this.sendToDevice(conn, { type: 'error', message: 'Session not found' })
      return
    }

    const machineConn = this.machines.get(session.machineId)
    if (!machineConn) {
      this.sendToDevice(conn, { type: 'error', message: 'Machine is offline' })
      return
    }

    const requestId = randomUUID()
    this.sendToMachine(machineConn, {
      type: 'hub_get_history',
      sessionId: msg.sessionId,
      requestId
    })
  }

  // ── Machine connections ─────────────────────────────────────────────

  private handleMachineConnection(ws: WebSocket, url: URL): void {
    const token = url.searchParams.get('token')
    if (!token) {
      ws.close(4001, 'Missing registration token')
      return
    }

    const machine = this.config.db.getMachineByToken(token)
    if (!machine) {
      ws.close(4001, 'Invalid registration token')
      return
    }

    // If already connected, close old connection
    const existing = this.machines.get(machine.id)
    if (existing) {
      existing.ws.close(4002, 'Replaced by new connection')
    }

    const conn: MachineConnection = {
      ws,
      machineId: machine.id,
      accountId: machine.accountId,
      machineName: machine.name
    }
    this.machines.set(machine.id, conn)
    this.config.db.updateMachineLastSeen(machine.id)

    // Notify devices that machine is online
    this.broadcastMachineList(machine.accountId)

    ws.on('message', (data) => {
      try {
        const msg = parseMessage<MachineToHubMsg>(data.toString())
        this.handleMachineMessage(conn, msg)
      } catch (err) {
        // Machine sent invalid message -- log but don't crash
        console.error('Invalid machine message:', err)
      }
    })

    ws.on('close', () => {
      // Only delete if this is still the active connection (avoids race on reconnect)
      if (this.machines.get(machine.id)?.ws === ws) {
        this.machines.delete(machine.id)
        this.broadcastMachineList(machine.accountId)
      }
    })
  }

  private handleMachineMessage(conn: MachineConnection, msg: MachineToHubMsg): void {
    switch (msg.type) {
      case 'machine_hello':
        // Machine announced its name
        conn.machineName = msg.machineName
        break

      case 'stream_text':
      case 'tool_call':
      case 'tool_result':
      case 'user_prompt':
      case 'session_history':
        this.relayToDevices(conn.accountId, msg)
        break

      case 'session_status': {
        this.config.db.updateSessionStatus(msg.sessionId, msg.status, msg.lastMessagePreview)
        this.relayToDevices(conn.accountId, msg)
        break
      }

      case 'session_done': {
        this.config.db.updateSessionStatus(msg.sessionId, 'idle')
        if (msg.sdkSessionId) {
          this.config.db.updateSessionSdkId(msg.sessionId, msg.sdkSessionId)
        }
        this.relayToDevices(conn.accountId, msg)
        this.broadcastSessionList(conn.accountId)
        break
      }

      case 'session_error': {
        this.config.db.updateSessionStatus(msg.sessionId, 'error', msg.error)
        this.relayToDevices(conn.accountId, msg)
        this.broadcastSessionList(conn.accountId)
        break
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private sendToDevice(conn: DeviceConnection, msg: HubToDeviceMsg): void {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(serializeMessage(msg))
    }
  }

  private sendToMachine(conn: MachineConnection, msg: HubToMachineMsg): void {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(serializeMessage(msg))
    }
  }

  private relayToDevices(accountId: string, msg: HubToDeviceMsg): void {
    for (const [, conn] of this.devices) {
      if (conn.accountId === accountId) {
        this.sendToDevice(conn, msg)
      }
    }
  }

  private broadcastSessionList(accountId: string): void {
    const sessions = this.config.db.listSessionsForAccount(accountId)
    this.relayToDevices(accountId, { type: 'session_list', sessions })
  }

  private broadcastMachineList(accountId: string): void {
    const machines = this.config.db.listMachinesForAccount(accountId)
    for (const m of machines) {
      m.online = this.machines.has(m.machineId)
    }
    this.relayToDevices(accountId, { type: 'machine_list', machines })
  }
}
