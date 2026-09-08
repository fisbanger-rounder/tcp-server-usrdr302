// simulator.js - Virtual PUSR DR302 simulator engine for multi-mode testing
const net = require('net');
const dgram = require('dgram');
const http = require('http');
const { calculateCRC16 } = require('./protocolDecoder');

class PusrSimulator {
  constructor(options = {}) {
    this.tcpPort = options.tcpPort || 5000;
    this.udpPort = options.udpPort || 5001;
    this.httpPort = options.httpPort || 3000;
    this.host = options.host || '127.0.0.1';
    
    this.isRunning = false;
    this.simulatedDevices = [];
    this.intervals = [];
  }

  getStatus() {
    return {
      running: this.isRunning,
      activeSimulators: this.simulatedDevices.map(d => ({
        id: d.id,
        name: d.name,
        mode: d.mode,
        location: d.location
      }))
    };
  }

  start(config = {}) {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[Simulator] Starting virtual PUSR DR302 devices...');

    // 1. Simulated DR302 #1 - TCP Client Mode with Modbus RTU Energy Meter
    this.spawnTcpDevice({
      id: 'MAC-9C:A5:25:88:1A:01',
      name: 'Substation A - Power Meter',
      location: 'Substation Site A',
      heartbeatSec: 15,
      telemetrySec: 5,
      macBytes: Buffer.from([0x9C, 0xA5, 0x25, 0x88, 0x1A, 0x01])
    });

    // 2. Simulated DR302 #2 - TCP Client Mode with Temperature & Humidity Sensor
    this.spawnTcpDevice({
      id: 'DR302_FACTORY_NORTH',
      name: 'Factory North - Temp/Humid',
      location: 'Industrial Plant North',
      heartbeatSec: 20,
      telemetrySec: 7,
      regText: 'DR302_FACTORY_NORTH'
    });

    // 3. Simulated DR302 #3 - HTTPD Client Mode
    this.spawnHttpdDevice({
      id: 'DR302_PUMP_STATION_3',
      name: 'Water Pump Station 3',
      location: 'Reservoir Site C',
      telemetrySec: 6
    });

    // 4. Simulated DR302 #4 - UDP Client Mode
    this.spawnUdpDevice({
      id: 'DR302_SOLAR_INVERTER_4',
      name: 'Solar Inverter Cluster 4',
      location: 'Solar Farm B',
      telemetrySec: 8
    });
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    console.log('[Simulator] Stopping virtual PUSR DR302 devices...');

    // Clear all timers
    for (const timer of this.intervals) {
      clearInterval(timer);
    }
    this.intervals = [];

    // Close all sockets
    for (const d of this.simulatedDevices) {
      if (d.socket && !d.socket.destroyed) {
        d.socket.destroy();
      }
    }
    this.simulatedDevices = [];
  }

  /**
   * Spawn a simulated DR302 in TCP Client mode
   */
  spawnTcpDevice(config) {
    const dev = {
      id: config.id,
      name: config.name,
      mode: 'TCP Client',
      location: config.location,
      socket: null
    };
    this.simulatedDevices.push(dev);

    const connectSocket = () => {
      if (!this.isRunning) return;
      const socket = new net.Socket();
      dev.socket = socket;

      socket.connect(this.tcpPort, this.host, () => {
        console.log(`[Simulator] ${config.name} (${config.id}) connected via TCP`);

        // Send Registration Packet upon connection (as DR302 does)
        if (config.macBytes) {
          socket.write(config.macBytes);
        } else if (config.regText) {
          socket.write(Buffer.from(config.regText, 'utf8'));
        }

        // Heartbeat loop (USR default is 'www.usr.cn')
        const hbTimer = setInterval(() => {
          if (!this.isRunning || socket.destroyed) return;
          socket.write(Buffer.from('www.usr.cn', 'utf8'));
        }, (config.heartbeatSec || 15) * 1000);
        this.intervals.push(hbTimer);

        // Telemetry loop (Modbus RTU Response frame)
        const telTimer = setInterval(() => {
          if (!this.isRunning || socket.destroyed) return;
          // Generate realistic Modbus RTU Response:
          // Slave ID: 1, Function: 0x03 (Read Holding Registers), Byte count: 4 (2 registers)
          const voltage = 2200 + Math.floor(Math.random() * 200); // 220.0V - 240.0V (x10)
          const current = 100 + Math.floor(Math.random() * 50);   // 10.0A - 15.0A (x10)

          const payload = Buffer.alloc(9);
          payload[0] = 0x01; // Slave ID
          payload[1] = 0x03; // Function Code: Read Holding Registers
          payload[2] = 0x04; // Byte Count (4 bytes = 2 registers)
          payload.writeUInt16BE(voltage, 3);
          payload.writeUInt16BE(current, 5);

          const crc = calculateCRC16(payload.subarray(0, 7));
          payload[7] = crc & 0xFF;        // CRC Lo
          payload[8] = (crc >> 8) & 0xFF; // CRC Hi

          socket.write(payload);
        }, (config.telemetrySec || 5) * 1000);
        this.intervals.push(telTimer);
      });

      // Handle downstream commands sent from server (e.g. Modbus Poll)
      socket.on('data', (data) => {
        // DR302 serial device receives command from server and replies!
        if (data.length >= 8 && data[1] === 0x03) {
          // Reply to Modbus Read Request
          setTimeout(() => {
            if (socket.destroyed) return;
            const reply = Buffer.alloc(9);
            reply[0] = data[0]; // Echo slave ID
            reply[1] = 0x03;
            reply[2] = 0x04;
            reply.writeUInt16BE(2355, 3); // 235.5 V
            reply.writeUInt16BE(124, 5);  // 12.4 A
            const crc = calculateCRC16(reply.subarray(0, 7));
            reply[7] = crc & 0xFF;
            reply[8] = (crc >> 8) & 0xFF;
            socket.write(reply);
          }, 40);
        }
      });

      socket.on('close', () => {
        if (this.isRunning) {
          setTimeout(connectSocket, 3000); // Auto-reconnect like real DR302
        }
      });

      socket.on('error', () => {
        // Silently handle retry
      });
    };

    connectSocket();
  }

  /**
   * Spawn a simulated DR302 in HTTPD Client mode
   */
  spawnHttpdDevice(config) {
    const dev = {
      id: config.id,
      name: config.name,
      mode: 'HTTPD Client',
      location: config.location
    };
    this.simulatedDevices.push(dev);

    const timer = setInterval(() => {
      if (!this.isRunning) return;

      const temp = (24 + Math.random() * 4).toFixed(1);
      const pressure = (101.3 + Math.random() * 2).toFixed(1);
      const postData = `[${config.id}] TEMP=${temp}C, PRESS=${pressure}kPa, FLOW=42.8L/m`;

      const req = http.request({
        hostname: this.host,
        port: this.httpPort,
        path: '/api/telemetry',
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'X-Device-ID': config.id,
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        res.resume(); // consume response
      });

      req.on('error', () => {});
      req.write(postData);
      req.end();
    }, (config.telemetrySec || 6) * 1000);

    this.intervals.push(timer);
  }

  /**
   * Spawn a simulated DR302 in UDP Client mode
   */
  spawnUdpDevice(config) {
    const dev = {
      id: config.id,
      name: config.name,
      mode: 'UDP Client',
      location: config.location
    };
    this.simulatedDevices.push(dev);

    const udpClient = dgram.createSocket('udp4');

    const timer = setInterval(() => {
      if (!this.isRunning) return;

      // Send Modbus RTU frame over UDP
      const solarWatts = 4500 + Math.floor(Math.random() * 500);
      const payload = Buffer.alloc(7);
      payload[0] = 0x02; // Slave ID 2
      payload[1] = 0x04; // Read Input Registers Response
      payload[2] = 0x02; // 2 bytes
      payload.writeUInt16BE(solarWatts, 3);
      const crc = calculateCRC16(payload.subarray(0, 5));
      payload[5] = crc & 0xFF;
      payload[6] = (crc >> 8) & 0xFF;

      udpClient.send(payload, 0, payload.length, this.udpPort, this.host, () => {});
    }, (config.telemetrySec || 8) * 1000);

    this.intervals.push(timer);
  }
}

module.exports = PusrSimulator;
