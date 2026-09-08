// udpServer.js - UDP Ingestion Server for PUSR DR302 (UDP Client mode)
const dgram = require('dgram');
const { formatHex, extractAscii, decodeModbusRTU, isHeartbeatPacket } = require('./protocolDecoder');

class PusrUdpServer {
  /**
   * @param {object} options
   * @param {number} options.port
   * @param {import('./deviceManager')} options.deviceManager
   */
  constructor(options = {}) {
    this.port = options.port || 5001;
    this.deviceManager = options.deviceManager;
    this.socket = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        console.error('[UDP Server] Error:', err.message);
      });

      this.socket.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });

      this.socket.bind(this.port, '0.0.0.0', () => {
        console.log(`[UDP Server] Listening for PUSR DR302 UDP datagrams on port ${this.port}`);
        resolve();
      });
    });
  }

  handleMessage(buffer, rinfo) {
    const remoteIp = rinfo.address;
    const remotePort = rinfo.port;
    const deviceId = `UDP-${remoteIp}:${remotePort}`;

    if (isHeartbeatPacket(buffer)) {
      this.deviceManager.recordHeartbeat(deviceId, {
        remoteAddress: remoteIp,
        remotePort,
        protocol: 'UDP'
      });
      return;
    }

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
      protocol: 'UDP'
    });
  }

  sendTo(buffer, ip, port) {
    if (!this.socket) throw new Error('UDP socket not initialized');
    return new Promise((resolve, reject) => {
      this.socket.send(buffer, 0, buffer.length, port, ip, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.close(() => {
          console.log('[UDP Server] Stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = PusrUdpServer;
