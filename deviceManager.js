// deviceManager.js - Central registry and lifecycle manager for remote PUSR DR302 devices
const EventEmitter = require('events');

class DeviceManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.devices = new Map(); // id -> device object
    this.packetLogs = [];     // In-memory circular log buffer
    this.maxLogs = options.maxLogs || 500;
    this.offlineTimeoutMs = options.offlineTimeoutMs || 60000; // 60s timeout for offline status
    
    // Periodic health checker
    this.watchdogInterval = setInterval(() => this.checkHeartbeats(), 10000);
  }

  /**
   * Get or register a device
   * @param {string} id Unique identifier (MAC address, Cloud ID, or IP:port)
   * @param {object} meta Additional metadata
   * @returns {object} Device record
   */
  getOrCreateDevice(id, meta = {}) {
    let device = this.devices.get(id);
    const now = new Date().toISOString();

    if (!device) {
      device = {
        id,
        alias: meta.alias || `USR-DR302 (${id})`,
        remoteAddress: meta.remoteAddress || 'Unknown',
        remotePort: meta.remotePort || 0,
        protocol: meta.protocol || 'TCP',
        status: 'ONLINE',
        isSimulator: !!meta.isSimulator,
        firstSeen: now,
        lastSeen: now,
        lastHeartbeat: now,
        packetCountRx: 0,
        packetCountTx: 0,
        bytesRx: 0,
        bytesTx: 0,
        lastData: null,
        socket: meta.socket || null
      };
      this.devices.set(id, device);
      this.emit('device:connected', this.sanitizeDevice(device));
    } else {
      // Update socket / network info if reconnected
      if (meta.socket) device.socket = meta.socket;
      if (meta.remoteAddress) device.remoteAddress = meta.remoteAddress;
      if (meta.remotePort) device.remotePort = meta.remotePort;
      if (meta.protocol) device.protocol = meta.protocol;
      
      const wasOffline = device.status !== 'ONLINE';
      device.status = 'ONLINE';
      device.lastSeen = now;
      if (wasOffline) {
        this.emit('device:connected', this.sanitizeDevice(device));
      }
    }

    return device;
  }

  /**
   * Re-key a temporary device ID (e.g. IP:Port) to its confirmed registration ID (e.g. MAC or Cloud ID)
   */
  rekeyDevice(oldId, newId, meta = {}) {
    const existingOld = this.devices.get(oldId);
    if (existingOld && oldId !== newId) {
      this.devices.delete(oldId);
    }

    let device = this.devices.get(newId);
    const now = new Date().toISOString();

    if (!device) {
      device = {
        id: newId,
        alias: meta.alias || `USR-DR302 (${newId})`,
        remoteAddress: meta.remoteAddress || (existingOld ? existingOld.remoteAddress : 'Unknown'),
        remotePort: meta.remotePort || (existingOld ? existingOld.remotePort : 0),
        protocol: meta.protocol || 'TCP',
        status: 'ONLINE',
        isSimulator: !!meta.isSimulator,
        firstSeen: existingOld ? existingOld.firstSeen : now,
        lastSeen: now,
        lastHeartbeat: now,
        packetCountRx: existingOld ? existingOld.packetCountRx : 0,
        packetCountTx: existingOld ? existingOld.packetCountTx : 0,
        bytesRx: existingOld ? existingOld.bytesRx : 0,
        bytesTx: existingOld ? existingOld.bytesTx : 0,
        lastData: existingOld ? existingOld.lastData : null,
        socket: meta.socket || (existingOld ? existingOld.socket : null)
      };
      this.devices.set(newId, device);
      this.emit('device:connected', this.sanitizeDevice(device));
    } else {
      if (meta.socket) device.socket = meta.socket;
      device.status = 'ONLINE';
      device.lastSeen = now;
      this.emit('device:connected', this.sanitizeDevice(device));
    }

    this.emit('devices:list', this.getAllDevices());
    return device;
  }

  /**
   * Record received data from a device
   */
  recordRx(deviceId, rawBuffer, parsedData, meta = {}) {
    const device = this.getOrCreateDevice(deviceId, meta);
    const now = new Date().toISOString();

    device.lastSeen = now;
    device.status = 'ONLINE';
    device.packetCountRx++;
    device.bytesRx += rawBuffer ? rawBuffer.length : 0;
    device.lastData = {
      timestamp: now,
      hex: parsedData.hex,
      ascii: parsedData.ascii,
      modbus: parsedData.modbus
    };

    const logEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      timestamp: now,
      direction: 'RX',
      deviceId: device.id,
      deviceAlias: device.alias,
      protocol: device.protocol,
      byteLength: rawBuffer ? rawBuffer.length : 0,
      hex: parsedData.hex,
      ascii: parsedData.ascii,
      modbus: parsedData.modbus,
      isHeartbeat: parsedData.isHeartbeat || false,
      remoteAddress: device.remoteAddress
    };

    this.addLog(logEntry);
    this.emit('telemetry:rx', logEntry);
    this.emit('device:updated', this.sanitizeDevice(device));

    return logEntry;
  }

  /**
   * Record transmitted data sent downstream to a device
   */
  recordTx(deviceId, rawBuffer, parsedData) {
    const device = this.devices.get(deviceId);
    const now = new Date().toISOString();

    if (device) {
      device.packetCountTx++;
      device.bytesTx += rawBuffer ? rawBuffer.length : 0;
      device.lastSeen = now;
    }

    const logEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      timestamp: now,
      direction: 'TX',
      deviceId,
      deviceAlias: device ? device.alias : deviceId,
      protocol: device ? device.protocol : 'TCP',
      byteLength: rawBuffer ? rawBuffer.length : 0,
      hex: parsedData.hex,
      ascii: parsedData.ascii,
      modbus: parsedData.modbus,
      isHeartbeat: false,
      remoteAddress: device ? device.remoteAddress : 'Local'
    };

    this.addLog(logEntry);
    this.emit('telemetry:tx', logEntry);
    if (device) {
      this.emit('device:updated', this.sanitizeDevice(device));
    }
    return logEntry;
  }

  /**
   * Record heartbeat from a device
   */
  recordHeartbeat(deviceId, meta = {}) {
    const device = this.getOrCreateDevice(deviceId, meta);
    const now = new Date().toISOString();
    device.lastHeartbeat = now;
    device.lastSeen = now;
    device.status = 'ONLINE';

    this.emit('device:heartbeat', {
      deviceId,
      timestamp: now
    });
    this.emit('device:updated', this.sanitizeDevice(device));
  }

  /**
   * Mark device as disconnected (e.g. TCP socket closed)
   */
  setDisconnected(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.status = 'OFFLINE';
      device.socket = null;
      this.emit('device:disconnected', this.sanitizeDevice(device));
      this.emit('device:updated', this.sanitizeDevice(device));
    }
  }

  /**
   * Set user alias for a device
   */
  updateAlias(deviceId, newAlias) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.alias = newAlias;
      this.emit('device:updated', this.sanitizeDevice(device));
      return true;
    }
    return false;
  }

  /**
   * Send raw buffer to a connected TCP device
   */
  sendToDevice(deviceId, buffer) {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device '${deviceId}' not found`);
    }
    if (!device.socket || device.socket.destroyed) {
      throw new Error(`Device '${deviceId}' has no active TCP connection`);
    }

    return new Promise((resolve, reject) => {
      device.socket.write(buffer, (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  }

  /**
   * Periodic health checker for devices
   */
  checkHeartbeats() {
    const now = Date.now();
    let hasChanges = false;

    for (const device of this.devices.values()) {
      if (device.status === 'ONLINE') {
        const lastSeenTime = new Date(device.lastSeen).getTime();
        const diff = now - lastSeenTime;

        if (diff > this.offlineTimeoutMs) {
          device.status = 'OFFLINE';
          hasChanges = true;
          this.emit('device:disconnected', this.sanitizeDevice(device));
        } else if (diff > this.offlineTimeoutMs / 2) {
          device.status = 'STANDBY';
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      this.emit('devices:list', this.getAllDevices());
    }
  }

  addLog(entry) {
    this.packetLogs.unshift(entry);
    if (this.packetLogs.length > this.maxLogs) {
      this.packetLogs.pop();
    }
  }

  clearLogs() {
    this.packetLogs = [];
    this.emit('logs:cleared');
  }

  /**
   * Strip non-serializable socket reference before broadcasting or returning via REST
   */
  sanitizeDevice(device) {
    const { socket, ...sanitized } = device;
    sanitized.hasActiveSocket = !!(socket && !socket.destroyed);
    return sanitized;
  }

  getAllDevices() {
    return Array.from(this.devices.values()).map(d => this.sanitizeDevice(d));
  }

  getLogs(limit = 100) {
    return this.packetLogs.slice(0, limit);
  }
}

module.exports = DeviceManager;
