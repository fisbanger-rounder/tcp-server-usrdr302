// httpdServer.js - HTTPD Client Receiver and Dashboard REST API
const express = require('express');
const os = require('os');
const { formatHex, extractAscii, decodeModbusRTU, isHeartbeatPacket, buildModbusReadRequest } = require('./protocolDecoder');

function createHttpdRouter(deviceManager, simulator) {
  const router = express.Router();

  /**
   * 1. PUSR DR302 HTTPD Client Endpoint
   * Supports raw binary/octet-stream, plain text, JSON, or form-urlencoded POST
   */
  router.post('/telemetry', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
    handleHttpdTelemetry(req, res, deviceManager);
  });

  // Alternative fallback paths commonly entered into DR302 URL settings
  router.post('/data', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
    handleHttpdTelemetry(req, res, deviceManager);
  });

  router.get('/telemetry', (req, res) => {
    handleHttpdGetTelemetry(req, res, deviceManager);
  });

  /**
   * 2. REST API for Dashboard Management
   */
  router.get('/devices', (req, res) => {
    res.json({ success: true, devices: deviceManager.getAllDevices() });
  });

  router.get('/logs', (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    res.json({ success: true, logs: deviceManager.getLogs(limit) });
  });

  router.post('/clear-logs', (req, res) => {
    deviceManager.clearLogs();
    res.json({ success: true, message: 'Logs cleared' });
  });

  router.post('/device/alias', express.json(), (req, res) => {
    const { deviceId, alias } = req.body;
    if (!deviceId || !alias) {
      return res.status(400).json({ success: false, error: 'deviceId and alias required' });
    }
    const updated = deviceManager.updateAlias(deviceId, alias);
    res.json({ success: updated });
  });

  router.post('/send', express.json(), async (req, res) => {
    const { deviceId, format, data, slaveId, startAddress, quantity } = req.body;

    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'deviceId required' });
    }

    try {
      let buffer;

      if (format === 'modbus-poll') {
        buffer = buildModbusReadRequest(
          parseInt(slaveId || 1, 10),
          parseInt(startAddress || 0, 10),
          parseInt(quantity || 2, 10)
        );
      } else if (format === 'hex') {
        // clean up spaces, e.g. "01 03 00 00 00 02 C4 0B" -> buffer
        const cleanHex = (data || '').replace(/[^0-9a-fA-F]/g, '');
        if (cleanHex.length % 2 !== 0) {
          return res.status(400).json({ success: false, error: 'Hex string length must be even' });
        }
        buffer = Buffer.from(cleanHex, 'hex');
      } else {
        // ASCII
        buffer = Buffer.from(data || '', 'utf8');
      }

      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ success: false, error: 'Data buffer is empty' });
      }

      await deviceManager.sendToDevice(deviceId, buffer);

      const parsedTx = {
        hex: formatHex(buffer),
        ascii: extractAscii(buffer),
        modbus: decodeModbusRTU(buffer)
      };
      const logEntry = deviceManager.recordTx(deviceId, buffer, parsedTx);

      res.json({ success: true, message: 'Command sent to device', logEntry });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * System network info (returns all server IPv4 addresses for easy configuration)
   */
  router.get('/system/network', (req, res) => {
    const interfaces = os.networkInterfaces();
    const addresses = [];

    for (const [name, ifaceList] of Object.entries(interfaces)) {
      for (const iface of ifaceList) {
        if (iface.family === 'IPv4' && !iface.internal) {
          addresses.push({
            interface: name,
            address: iface.address,
            netmask: iface.netmask
          });
        }
      }
    }

    res.json({
      success: true,
      hostname: os.hostname(),
      platform: os.platform(),
      addresses,
      ports: {
        tcp: 5000,
        udp: 5001,
        http: 3000
      }
    });
  });

  /**
   * Virtual Simulator controls
   */
  router.get('/simulator/status', (req, res) => {
    if (!simulator) return res.json({ success: false, running: false });
    res.json({ success: true, ...simulator.getStatus() });
  });

  router.post('/simulator/toggle', express.json(), (req, res) => {
    if (!simulator) return res.status(400).json({ success: false, error: 'Simulator unavailable' });
    const { action, mode, deviceCount } = req.body;
    if (action === 'start') {
      simulator.start({ mode: mode || 'tcp', count: deviceCount || 2 });
    } else {
      simulator.stop();
    }
    res.json({ success: true, ...simulator.getStatus() });
  });

  return router;
}

function handleHttpdTelemetry(req, res, deviceManager) {
  const remoteIp = (req.ip || req.connection.remoteAddress || '').replace(/^.*:/, '');
  const customIdHeader = req.headers['x-device-id'] || req.headers['device-id'] || req.headers['user-agent'];
  const deviceId = customIdHeader && customIdHeader.length < 32 
    ? customIdHeader 
    : `HTTPD-${remoteIp}:${req.connection.remotePort || '80'}`;

  const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ? String(req.body) : '');

  if (isHeartbeatPacket(bodyBuffer)) {
    deviceManager.recordHeartbeat(deviceId, {
      remoteAddress: remoteIp,
      remotePort: req.connection.remotePort || 80,
      protocol: 'HTTPD'
    });
    return res.status(200).send('OK');
  }

  const hex = formatHex(bodyBuffer);
  const ascii = extractAscii(bodyBuffer);
  const modbus = decodeModbusRTU(bodyBuffer);

  deviceManager.recordRx(deviceId, bodyBuffer, {
    hex,
    ascii,
    modbus,
    isHeartbeat: false
  }, {
    remoteAddress: remoteIp,
    remotePort: req.connection.remotePort || 80,
    protocol: 'HTTPD'
  });

  // DR302 forwards HTTP response body back to the RS485 serial port!
  // Send simple ACK or custom response
  res.status(200).send('ACK');
}

function handleHttpdGetTelemetry(req, res, deviceManager) {
  const remoteIp = (req.ip || req.connection.remoteAddress || '').replace(/^.*:/, '');
  const rawData = req.query.data || req.query.payload || JSON.stringify(req.query);
  const deviceId = req.query.deviceId || `HTTPD-${remoteIp}`;
  const bodyBuffer = Buffer.from(rawData, 'utf8');

  const hex = formatHex(bodyBuffer);
  const ascii = extractAscii(bodyBuffer);
  const modbus = decodeModbusRTU(bodyBuffer);

  deviceManager.recordRx(deviceId, bodyBuffer, {
    hex,
    ascii,
    modbus,
    isHeartbeat: false
  }, {
    remoteAddress: remoteIp,
    remotePort: 80,
    protocol: 'HTTPD'
  });

  res.status(200).send('ACK');
}

module.exports = { createHttpdRouter };
