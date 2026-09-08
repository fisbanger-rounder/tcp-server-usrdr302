// app.js - Frontend Client Controller for PUSR DR302 Hub

(function() {
  'use strict';

  // State
  let ws = null;
  let isConnected = false;
  const devices = new Map();
  const logs = [];
  let isSimulatorRunning = false;
  let networkInfo = null;

  // DOM Elements
  const wsIndicator = document.getElementById('ws-indicator');
  const wsStatusText = document.getElementById('ws-status-text');
  const metricTcpPort = document.getElementById('metric-tcp-port');
  const metricHttpPort = document.getElementById('metric-http-port');
  const metricUdpPort = document.getElementById('metric-udp-port');
  const btnToggleSim = document.getElementById('btn-toggle-simulator');
  const simBtnLabel = document.getElementById('simulator-btn-label');
  const btnSimAction = document.getElementById('btn-sim-action');

  // Stats
  const statActiveDevices = document.getElementById('stat-active-devices');
  const statTotalDevices = document.getElementById('stat-total-devices');
  const statRxPackets = document.getElementById('stat-rx-packets');
  const statRxBytes = document.getElementById('stat-rx-bytes');
  const statTxPackets = document.getElementById('stat-tx-packets');
  const statHeartbeatStatus = document.getElementById('stat-heartbeat-status');
  const badgeOnlineCount = document.getElementById('badge-online-count');
  const badgePacketCount = document.getElementById('badge-packet-count');

  // Table
  const devicesTbody = document.getElementById('devices-tbody');
  const deviceSearch = document.getElementById('device-search');

  // Terminal
  const terminalStream = document.getElementById('terminal-stream');
  const autoscrollToggle = document.getElementById('autoscroll-toggle');
  const hideHeartbeatToggle = document.getElementById('hide-heartbeat-toggle');
  const btnClearLogs = document.getElementById('btn-clear-logs');

  // Command Form
  const cmdTargetDevice = document.getElementById('cmd-target-device');
  const cmdTypeRadios = document.querySelectorAll('input[name="cmd-type"]');
  const cmdModbusFields = document.getElementById('cmd-modbus-fields');
  const cmdHexFields = document.getElementById('cmd-hex-fields');
  const cmdAsciiFields = document.getElementById('cmd-ascii-fields');
  const modbusSlaveId = document.getElementById('modbus-slave-id');
  const modbusStartAddr = document.getElementById('modbus-start-addr');
  const modbusQty = document.getElementById('modbus-qty');
  const modbusFramePreview = document.getElementById('modbus-frame-preview');
  const hexInputData = document.getElementById('hex-input-data');
  const asciiInputData = document.getElementById('ascii-input-data');
  const btnSendCommand = document.getElementById('btn-send-command');
  const cmdResultAlert = document.getElementById('cmd-result-alert');

  // Guide
  const detectedIpList = document.getElementById('detected-ip-list');
  const guideServerIp = document.getElementById('guide-server-ip');
  const guideServerIpHttp = document.getElementById('guide-server-ip-http');

  // Initialize
  initTabs();
  initWebSocket();
  initCommandForm();
  initSearch();
  fetchNetworkInfo();

  window.startSimulatorFromEmpty = function() {
    toggleSimulator(true);
  };

  // 1. WebSocket Setup
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      isConnected = true;
      wsIndicator.className = 'pulse-dot active';
      wsStatusText.textContent = 'Hub Connected';
    };

    ws.onclose = () => {
      isConnected = false;
      wsIndicator.className = 'pulse-dot';
      wsStatusText.textContent = 'Disconnected (Reconnecting...)';
      setTimeout(initWebSocket, 3000);
    };

    ws.onerror = () => {
      isConnected = false;
      wsIndicator.className = 'pulse-dot';
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (err) {
        console.error('Error parsing WS message:', err);
      }
    };
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'init:state':
        onInitState(msg.payload);
        break;
      case 'telemetry:rx':
        onTelemetryRx(msg.payload);
        break;
      case 'telemetry:tx':
        onTelemetryTx(msg.payload);
        break;
      case 'device:connected':
      case 'device:updated':
        onDeviceUpdate(msg.payload);
        break;
      case 'device:disconnected':
        onDeviceDisconnect(msg.payload);
        break;
      case 'device:heartbeat':
        onDeviceHeartbeat(msg.payload);
        break;
      case 'devices:list':
        onDeviceList(msg.payload);
        break;
      case 'logs:cleared':
        logs.length = 0;
        terminalStream.innerHTML = '';
        updateStats();
        break;
    }
  }

  function onInitState(state) {
    if (state.ports) {
      metricTcpPort.textContent = state.ports.tcp;
      metricHttpPort.textContent = state.ports.http;
      metricUdpPort.textContent = state.ports.udp;
    }

    if (state.devices) {
      devices.clear();
      for (const d of state.devices) {
        devices.set(d.id, d);
      }
    }

    if (state.recentLogs) {
      logs.length = 0;
      for (const log of state.recentLogs) {
        logs.push(log);
      }
      renderTerminalLogs();
    }

    if (state.simulator) {
      updateSimulatorUi(state.simulator.running);
    }

    renderDeviceTable();
    updateCommandDeviceSelect();
    updateStats();
  }

  function onTelemetryRx(entry) {
    logs.unshift(entry);
    if (logs.length > 500) logs.pop();

    appendLogToTerminal(entry, true);
    updateStats();
  }

  function onTelemetryTx(entry) {
    logs.unshift(entry);
    if (logs.length > 500) logs.pop();

    appendLogToTerminal(entry, true);
    updateStats();
  }

  function onDeviceUpdate(device) {
    devices.set(device.id, device);
    renderDeviceTable();
    updateCommandDeviceSelect();
    updateStats();
  }

  function onDeviceDisconnect(device) {
    devices.set(device.id, device);
    renderDeviceTable();
    updateCommandDeviceSelect();
    updateStats();
  }

  function onDeviceHeartbeat(payload) {
    const dev = devices.get(payload.deviceId);
    if (dev) {
      dev.lastHeartbeat = payload.timestamp;
      dev.lastSeen = payload.timestamp;
      dev.status = 'ONLINE';
      renderDeviceTable();
      updateStats();
    }
  }

  function onDeviceList(list) {
    devices.clear();
    for (const d of list) {
      devices.set(d.id, d);
    }
    renderDeviceTable();
    updateCommandDeviceSelect();
    updateStats();
  }

  // 2. Navigation Tabs
  function initTabs() {
    const navItems = document.querySelectorAll('.sidebar-menu .nav-item');
    const panes = document.querySelectorAll('.tab-pane');

    navItems.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-tab');
        navItems.forEach(i => i.classList.remove('active'));
        panes.forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        const activePane = document.getElementById(tabId);
        if (activePane) activePane.classList.add('active');
      });
    });
  }

  // 3. Device Fleet Table
  function renderDeviceTable() {
    const query = (deviceSearch.value || '').toLowerCase().trim();
    const all = Array.from(devices.values());

    const filtered = all.filter(d => {
      if (!query) return true;
      return (
        d.id.toLowerCase().includes(query) ||
        (d.alias && d.alias.toLowerCase().includes(query)) ||
        (d.remoteAddress && d.remoteAddress.toLowerCase().includes(query)) ||
        (d.protocol && d.protocol.toLowerCase().includes(query))
      );
    });

    if (filtered.length === 0) {
      devicesTbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="8">
            <div class="empty-state">
              <div class="empty-icon">📡</div>
              <h3>${all.length === 0 ? 'Waiting for incoming PUSR DR302 connections' : 'No matching devices found'}</h3>
              <p>${all.length === 0 ? 'No devices have connected yet. Set your DR302 to TCP Client, HTTPD, or UDP mode, or start the Virtual Simulator to test immediately.' : 'Try adjusting your search query.'}</p>
              ${all.length === 0 ? '<button class="btn btn-primary" onclick="window.startSimulatorFromEmpty()">Start Virtual DR302 Simulator</button>' : ''}
            </div>
          </td>
        </tr>
      `;
      return;
    }

    devicesTbody.innerHTML = filtered.map(d => {
      const isOnline = d.status === 'ONLINE';
      const statusCls = isOnline ? 'online' : (d.status === 'STANDBY' ? 'standby' : 'offline');
      const timeAgo = formatTimeAgo(d.lastSeen);
      const tagClass = d.protocol === 'TCP' ? 'tag-tcp' : (d.protocol === 'HTTPD' ? 'tag-http' : 'tag-udp');

      return `
        <tr data-device-id="${d.id}">
          <td>
            <span class="status-badge ${statusCls}">
              <span class="pulse-dot ${isOnline ? 'active' : ''}"></span>
              ${d.status}
            </span>
          </td>
          <td>
            <span class="device-alias-edit" onclick="window.promptEditAlias('${d.id}')" title="Click to rename">
              ${escapeHtml(d.alias || d.id)}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
              </svg>
            </span>
          </td>
          <td>
            <span class="code-font" style="color:#38bdf8;">${escapeHtml(d.id)}</span>
            ${d.isSimulator ? '<span class="tag" style="background:rgba(255,255,255,0.06);font-size:0.7rem;margin-left:4px;">SIM</span>' : ''}
          </td>
          <td>
            <span class="code-font">${escapeHtml(d.remoteAddress)}:${d.remotePort || 0}</span>
          </td>
          <td>
            <span class="tag ${tagClass}">${d.protocol || 'TCP'}</span>
          </td>
          <td>
            <span class="code-font" style="color:#06b6d4;">${d.packetCountRx || 0}</span> / 
            <span class="code-font" style="color:#a855f7;">${d.packetCountTx || 0}</span>
          </td>
          <td>
            <span title="${d.lastSeen || ''}">${timeAgo}</span>
          </td>
          <td>
            <button class="btn btn-sm btn-outline" onclick="window.selectForCommand('${d.id}')" ${!d.hasActiveSocket ? 'disabled title="Only available for active TCP connections"' : ''}>
              Send TX
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  window.promptEditAlias = function(deviceId) {
    const dev = devices.get(deviceId);
    if (!dev) return;
    const current = dev.alias || deviceId;
    const newAlias = prompt('Enter a friendly alias for this USR-DR302:', current);
    if (newAlias && newAlias.trim() && newAlias !== current) {
      fetch('/api/device/alias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, alias: newAlias.trim() })
      });
    }
  };

  window.selectForCommand = function(deviceId) {
    const tabCommandBtn = document.querySelector('[data-tab="tab-command"]');
    if (tabCommandBtn) tabCommandBtn.click();
    cmdTargetDevice.value = deviceId;
  };

  function updateCommandDeviceSelect() {
    const prev = cmdTargetDevice.value;
    cmdTargetDevice.innerHTML = '<option value="">-- Select an active TCP-connected device --</option>';

    for (const d of devices.values()) {
      if (d.hasActiveSocket || d.protocol === 'TCP') {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = `${d.alias || d.id} (${d.remoteAddress}:${d.remotePort}) [${d.status}]`;
        if (!d.hasActiveSocket) {
          opt.textContent += ' - Socket Closed';
          opt.disabled = true;
        }
        cmdTargetDevice.appendChild(opt);
      }
    }

    if (prev) {
      cmdTargetDevice.value = prev;
    }
  }

  // 4. Telemetry Stream & Terminal
  function renderTerminalLogs() {
    terminalStream.innerHTML = '';
    const shouldHideHeartbeats = hideHeartbeatToggle.checked;
    
    for (let i = logs.length - 1; i >= 0; i--) {
      const entry = logs[i];
      if (shouldHideHeartbeats && entry.isHeartbeat) continue;
      appendLogToTerminal(entry, false);
    }

    if (autoscrollToggle.checked) {
      terminalStream.scrollTop = terminalStream.scrollHeight;
    }
  }

  function appendLogToTerminal(entry, isNew = false) {
    const shouldHideHeartbeats = hideHeartbeatToggle.checked;
    if (shouldHideHeartbeats && entry.isHeartbeat) return;

    const div = document.createElement('div');
    const isRx = entry.direction === 'RX';
    const dirClass = isRx ? 'rx' : 'tx';
    const hbClass = entry.isHeartbeat ? 'heartbeat' : '';

    div.className = `packet-card ${dirClass} ${hbClass}`;
    
    let modbusHtml = '';
    if (entry.modbus) {
      const m = entry.modbus;
      let regText = '';
      if (m.registers && m.registers.length > 0) {
        regText = `Registers: [ ${m.registers.map((r, i) => `R${i}: ${r} (0x${r.toString(16).toUpperCase()})`).join(', ')} ]`;
      }
      if (m.floats && m.floats.length > 0) {
        regText += `<br>Decoded Floats: [ ${m.floats.join(', ')} ]`;
      }
      if (m.type === 'Request / Poll') {
        regText = `Poll Start Register: ${m.startAddress}, Count: ${m.quantity}`;
      }

      modbusHtml = `
        <div class="modbus-box">
          <div class="modbus-header">
            <span>🛡️ Modbus RTU Slave #${m.slaveId}</span>
            <span>• ${escapeHtml(m.functionName || '')}</span>
            <span style="color:#34d399;">• CRC Valid (${m.crc || 'OK'})</span>
          </div>
          <div class="modbus-registers">${regText}</div>
        </div>
      `;
    }

    const timeFormatted = new Date(entry.timestamp).toLocaleTimeString();

    div.innerHTML = `
      <div class="packet-header">
        <span class="dir-badge ${dirClass}">${entry.direction}</span>
        <span class="packet-device">${escapeHtml(entry.deviceAlias || entry.deviceId)}</span>
        <span class="packet-proto">${entry.protocol}</span>
        <span class="packet-time">${timeFormatted} (${entry.byteLength} B)</span>
        ${entry.isHeartbeat ? '<span class="tag" style="background:rgba(245,158,11,0.2);color:#f59e0b;font-size:0.68rem;">HEARTBEAT</span>' : ''}
      </div>
      <div class="packet-hex">${escapeHtml(entry.hex || '')}</div>
      ${entry.ascii ? `<div class="packet-ascii">ASCII: "${escapeHtml(entry.ascii)}"</div>` : ''}
      ${modbusHtml}
    `;

    if (isNew) {
      terminalStream.appendChild(div);
      // Limit DOM cards
      if (terminalStream.children.length > 300) {
        terminalStream.removeChild(terminalStream.firstChild);
      }
      if (autoscrollToggle.checked) {
        terminalStream.scrollTop = terminalStream.scrollHeight;
      }
    } else {
      terminalStream.appendChild(div);
    }
  }

  // 5. 2-Way Command Transmitter
  function initCommandForm() {
    cmdTypeRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        const val = radio.value;
        cmdModbusFields.style.display = val === 'modbus-poll' ? 'block' : 'none';
        cmdHexFields.style.display = val === 'hex' ? 'block' : 'none';
        cmdAsciiFields.style.display = val === 'ascii' ? 'block' : 'none';
      });
    });

    [modbusSlaveId, modbusStartAddr, modbusQty].forEach(input => {
      input.addEventListener('input', updateModbusPreview);
    });
    updateModbusPreview();

    btnSendCommand.addEventListener('click', async () => {
      const deviceId = cmdTargetDevice.value;
      if (!deviceId) {
        showAlert('Please select a target DR302 device', 'error');
        return;
      }

      const type = document.querySelector('input[name="cmd-type"]:checked').value;
      btnSendCommand.disabled = true;
      btnSendCommand.querySelector('span').textContent = 'Transmitting...';

      try {
        const body = { deviceId, format: type };
        if (type === 'modbus-poll') {
          body.slaveId = parseInt(modbusSlaveId.value, 10);
          body.startAddress = parseInt(modbusStartAddr.value, 10);
          body.quantity = parseInt(modbusQty.value, 10);
        } else if (type === 'hex') {
          body.data = hexInputData.value;
        } else {
          body.data = asciiInputData.value;
        }

        const res = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();

        if (data.success) {
          showAlert(`Command successfully transmitted to ${deviceId}! Check Telemetry Terminal for slave response.`, 'success');
        } else {
          showAlert(`Failed to send: ${data.error}`, 'error');
        }
      } catch (err) {
        showAlert(`Error sending command: ${err.message}`, 'error');
      } finally {
        btnSendCommand.disabled = false;
        btnSendCommand.querySelector('span').textContent = 'Transmit to DR302';
      }
    });

    btnClearLogs.addEventListener('click', async () => {
      await fetch('/api/clear-logs', { method: 'POST' });
    });

    hideHeartbeatToggle.addEventListener('change', () => {
      renderTerminalLogs();
    });
  }

  function showAlert(msg, type) {
    cmdResultAlert.textContent = msg;
    cmdResultAlert.className = `alert-box ${type}`;
    cmdResultAlert.style.display = 'block';
    setTimeout(() => {
      cmdResultAlert.style.display = 'none';
    }, 6000);
  }

  function updateModbusPreview() {
    const slaveId = parseInt(modbusSlaveId.value || 1, 10);
    const startAddr = parseInt(modbusStartAddr.value || 0, 10);
    const qty = parseInt(modbusQty.value || 2, 10);

    const buf = [
      slaveId & 0xFF,
      0x03,
      (startAddr >> 8) & 0xFF,
      startAddr & 0xFF,
      (qty >> 8) & 0xFF,
      qty & 0xFF
    ];

    // Calculate CRC16
    let crc = 0xFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        if ((crc & 0x0001) !== 0) {
          crc = (crc >> 1) ^ 0xA001;
        } else {
          crc = crc >> 1;
        }
      }
    }

    buf.push(crc & 0xFF);
    buf.push((crc >> 8) & 0xFF);

    const hexStr = buf.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    modbusFramePreview.textContent = hexStr;
  }

  // 6. Network Info & Guide
  async function fetchNetworkInfo() {
    try {
      const res = await fetch('/api/system/network');
      networkInfo = await res.json();
      if (networkInfo && networkInfo.addresses) {
        detectedIpList.innerHTML = networkInfo.addresses.map(a => {
          return `
            <div class="ip-badge" title="Interface: ${a.interface}">
              <span>${escapeHtml(a.interface)}:</span> ${a.address}
            </div>
          `;
        }).join('');

        // Find primary LAN IP
        const primary = networkInfo.addresses.find(a => a.address.startsWith('192.168.') || a.address.startsWith('10.')) || networkInfo.addresses[0];
        if (primary) {
          guideServerIp.textContent = primary.address;
          guideServerIpHttp.textContent = primary.address;
        }
      }
    } catch (err) {
      console.warn('Could not fetch network info:', err);
    }
  }

  // 7. Virtual Simulator
  btnToggleSim.addEventListener('click', () => {
    toggleSimulator(!isSimulatorRunning);
  });

  btnSimAction.addEventListener('click', () => {
    toggleSimulator(!isSimulatorRunning);
  });

  async function toggleSimulator(start) {
    try {
      const res = await fetch('/api/simulator/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: start ? 'start' : 'stop' })
      });
      const data = await res.json();
      updateSimulatorUi(data.running);
    } catch (err) {
      console.error('Failed to toggle simulator:', err);
    }
  }

  function updateSimulatorUi(running) {
    isSimulatorRunning = running;
    if (running) {
      btnToggleSim.className = 'btn btn-simulator running';
      simBtnLabel.textContent = 'Stop Simulator';
      btnSimAction.textContent = 'Stop All Simulators';
      btnSimAction.className = 'btn btn-outline';

      for (let i = 1; i <= 4; i++) {
        const el = document.getElementById(`sim-status-${i}`);
        if (el) {
          el.textContent = 'Streaming';
          el.style.color = '#34d399';
        }
      }
    } else {
      btnToggleSim.className = 'btn btn-simulator';
      simBtnLabel.textContent = 'Start Simulator';
      btnSimAction.textContent = 'Start All Simulators';
      btnSimAction.className = 'btn btn-primary';

      for (let i = 1; i <= 4; i++) {
        const el = document.getElementById(`sim-status-${i}`);
        if (el) {
          el.textContent = 'Standby';
          el.style.color = 'var(--text-dim)';
        }
      }
    }
  }

  // 8. Stats & Helpers
  function updateStats() {
    const all = Array.from(devices.values());
    const online = all.filter(d => d.status === 'ONLINE').length;
    let totalRxPackets = 0;
    let totalTxPackets = 0;
    let totalRxBytes = 0;

    for (const d of all) {
      totalRxPackets += (d.packetCountRx || 0);
      totalTxPackets += (d.packetCountTx || 0);
      totalRxBytes += (d.bytesRx || 0);
    }

    statActiveDevices.textContent = online;
    statTotalDevices.textContent = all.length;
    badgeOnlineCount.textContent = online;
    badgePacketCount.textContent = logs.length;

    statRxPackets.textContent = totalRxPackets;
    statRxBytes.textContent = formatBytes(totalRxBytes);
    statTxPackets.textContent = totalTxPackets;
  }

  function initSearch() {
    deviceSearch.addEventListener('input', () => {
      renderDeviceTable();
    });
  }

  function formatTimeAgo(isoString) {
    if (!isoString) return 'Never';
    const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 3) return 'Just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Periodic table re-render for timeAgo updates
  setInterval(() => {
    renderDeviceTable();
  }, 5000);

})();
