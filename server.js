// server.js - Master entry point for PUSR DR302 Multi-Protocol Telemetry Hub
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');

const DeviceManager = require('./deviceManager');
const PusrTcpServer = require('./tcpServer');
const PusrUdpServer = require('./udpServer');
const { createHttpdRouter } = require('./httpdServer');
const PusrSimulator = require('./simulator');

const HTTP_PORT = process.env.HTTP_PORT || 3000;
const TCP_PORT = process.env.TCP_PORT || 5000;
const UDP_PORT = process.env.UDP_PORT || 5001;

// 1. Initialize Device Registry & Manager
const deviceManager = new DeviceManager({
  maxLogs: 500,
  offlineTimeoutMs: 60000 // 60s
});

// 2. Initialize Virtual Simulator
const simulator = new PusrSimulator({
  tcpPort: TCP_PORT,
  udpPort: UDP_PORT,
  httpPort: HTTP_PORT,
  host: '127.0.0.1'
});

// 3. Setup Express Application
const app = express();
app.use(cors());

// Serve static frontend UI
app.use(express.static(path.join(__dirname, 'public')));

// Mount API routes
const apiRouter = createHttpdRouter(deviceManager, simulator);
app.use('/api', apiRouter);

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 4. Create HTTP Server & WebSocket Server
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

function broadcastWs(type, payload) {
  const message = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Connect DeviceManager events to WebSocket broadcasts
deviceManager.on('telemetry:rx', (entry) => broadcastWs('telemetry:rx', entry));
deviceManager.on('telemetry:tx', (entry) => broadcastWs('telemetry:tx', entry));
deviceManager.on('device:connected', (device) => broadcastWs('device:connected', device));
deviceManager.on('device:disconnected', (device) => broadcastWs('device:disconnected', device));
deviceManager.on('device:heartbeat', (hb) => broadcastWs('device:heartbeat', hb));
deviceManager.on('device:updated', (device) => broadcastWs('device:updated', device));
deviceManager.on('devices:list', (devices) => broadcastWs('devices:list', devices));
deviceManager.on('logs:cleared', () => broadcastWs('logs:cleared', null));

wss.on('connection', (ws) => {
  // Send initial state snapshot to connected dashboard
  ws.send(JSON.stringify({
    type: 'init:state',
    payload: {
      devices: deviceManager.getAllDevices(),
      recentLogs: deviceManager.getLogs(60),
      ports: {
        tcp: TCP_PORT,
        udp: UDP_PORT,
        http: HTTP_PORT
      },
      simulator: simulator.getStatus()
    }
  }));
});

// 5. Initialize TCP and UDP Ingestion Servers
const tcpServer = new PusrTcpServer({ port: TCP_PORT, deviceManager });
const udpServer = new PusrUdpServer({ port: UDP_PORT, deviceManager });

async function bootstrap() {
  try {
    await tcpServer.start();
    await udpServer.start();
    
    httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
      console.log('===============================================================');
      console.log('  PUSR USR-DR302 MULTI-PROTOCOL INGESTION SERVER & DASHBOARD  ');
      console.log('===============================================================');
      console.log(`  > Web Dashboard:      http://localhost:${HTTP_PORT}`);
      console.log(`  > TCP Ingest (DR302): Port ${TCP_PORT} (TCP Client Mode)`);
      console.log(`  > UDP Ingest (DR302): Port ${UDP_PORT} (UDP Client Mode)`);
      console.log(`  > HTTPD Ingest:       http://localhost:${HTTP_PORT}/api/telemetry`);
      console.log('===============================================================');
    });
  } catch (err) {
    console.error('Failed to start servers:', err);
    process.exit(1);
  }
}

bootstrap();

process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down...');
  simulator.stop();
  await tcpServer.stop();
  await udpServer.stop();
  httpServer.close(() => {
    console.log('All servers stopped.');
    process.exit(0);
  });
});
