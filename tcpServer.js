// tcpServer.js - High-performance TCP Ingestion Server for PUSR DR302 (TCP Client mode)
const net = require('net');
const { formatHex, extractAscii, decodeModbusRTU, isHeartbeatPacket } = require('./protocolDecoder');

class PusrTcpServer {
  /**
   * @param {object} options
   * @param {number} options.port
   * @param {import('./deviceManager')} options.deviceManager
   */
  constructor(options = {}) {
    this.port = options.port || 5000;
    this.deviceManager = options.deviceManager;
    this.server = null;
    this.sockets = new Map(); // socketKey -> socket
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        console.error('[TCP Server] Error:', err.message);
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[TCP Server] Listening for PUSR DR302 connections on port ${this.port}`);
        resolve();
      });
    });
  }

  handleConnection(socket) {
    const remoteIp = socket.remoteAddress.replace(/^.*:/, ''); // normalize IPv4
    const remotePort = socket.remotePort;
    const socketKey = `${remoteIp}:${remotePort}`;
    let deviceId = `DR302-${remoteIp}:${remotePort}`;
    let isIdentified = false;

    console.log(`[TCP Server] New incoming connection from ${remoteIp}:${remotePort}`);

    // Register initial connection
    this.deviceManager.getOrCreateDevice(deviceId, {
      remoteAddress: remoteIp,
      remotePort,
      protocol: 'TCP',
      socket
    });

    this.sockets.set(socketKey, { socket, deviceId });

    socket.on('data', (buffer) => {
      // 1. Check if first packet is a DR302 Registration Packet
      if (!isIdentified) {
        const potentialId = this.extractRegistrationId(buffer);
        if (potentialId) {
          const oldId = deviceId;
          deviceId = potentialId;
          isIdentified = true;
          this.deviceManager.rekeyDevice(oldId, deviceId, {
            alias: `USR-DR302 (${deviceId})`,
            remoteAddress: remoteIp,
            remotePort,
            protocol: 'TCP',
            socket
          });
          const socketEntry = this.sockets.get(socketKey);
          if (socketEntry) socketEntry.deviceId = deviceId;
          console.log(`[TCP Server] Device identified via registration packet: ${deviceId} (rekeyed from ${oldId})`);
          // If this was purely a registration packet without serial payload, return
          if (this.isPureRegistrationPacket(buffer, potentialId)) {
            return;
          }
        }
      }

      // 2. Check if packet is a DR302 Keep-alive / Heartbeat
      if (isHeartbeatPacket(buffer)) {
        this.deviceManager.recordHeartbeat(deviceId, {
          remoteAddress: remoteIp,
          remotePort,
          protocol: 'TCP',
          socket
        });
        return;
      }

      // 3. Process Serial Telemetry Payload (Modbus RTU / Raw Hex / ASCII)
      const hex = formatHex(buffer);
      const ascii = extractAscii(buffer);
      const modbus = decodeModbusRTU(buffer);

      this.deviceManager.recordRx(deviceId, buffer, {
        hex,
        ascii,
        modbus,
        isHeartbeat: false
      }, {
        remoteAddress: remoteIp,
        remotePort,
        protocol: 'TCP',
        socket
      });
    });

    socket.on('close', (hadError) => {
      console.log(`[TCP Server] Connection closed for ${deviceId} (error: ${hadError})`);
      this.sockets.delete(socketKey);
      this.deviceManager.setDisconnected(deviceId);
    });

    socket.on('error', (err) => {
      console.warn(`[TCP Server] Socket error for ${deviceId}:`, err.message);
    });
  }

  /**
   * Detect and extract device ID from common PUSR registration packets
   * USR-DR302 can send:
   * - 6-byte binary MAC: e.g. [0x9C, 0xA5, 0x25, 0x12, 0x34, 0x56]
   * - 12-char hex MAC: e.g. "9CA525123456"
   * - Custom text string: e.g. "ID:DR302_01" or "DR302_SUBSTATION_01"
   */
  extractRegistrationId(buffer) {
    if (!buffer || buffer.length === 0) return null;

    // Check 6-byte binary MAC
    if (buffer.length === 6) {
      const mac = Array.from(buffer)
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join(':');
      return `MAC-${mac}`;
    }

    // Check ASCII string
    const text = buffer.toString('utf8').trim();
    if (text.length >= 4 && text.length <= 32 && /^[a-zA-Z0-9_\-:]+$/.test(text)) {
      if (text.toLowerCase() === 'www.usr.cn') return null; // That's a heartbeat, not ID
      return text;
    }

    return null;
  }

  isPureRegistrationPacket(buffer, detectedId) {
    if (buffer.length === 6 && detectedId.startsWith('MAC-')) return true;
    const text = buffer.toString('utf8').trim();
    if (text === detectedId) return true;
    return false;
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[TCP Server] Stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = PusrTcpServer;
