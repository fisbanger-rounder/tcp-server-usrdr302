// protocolDecoder.js - Modbus RTU, Hex, and ASCII decoder for PUSR DR302 data frames

/**
 * Calculate Modbus RTU CRC16 (Polynomial: 0xA001, Init: 0xFFFF)
 * @param {Buffer} buffer 
 * @returns {number} 16-bit CRC integer (Little-endian in Modbus frames)
 */
function calculateCRC16(buffer) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x0001) !== 0) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc = crc >> 1;
      }
    }
  }
  return crc;
}

/**
 * Format buffer to space-separated uppercase HEX string
 * @param {Buffer} buffer 
 * @returns {string} e.g. "01 03 04 00 1A 00 2C 7B 4E"
 */
function formatHex(buffer) {
  if (!buffer || buffer.length === 0) return '';
  return Array.from(buffer)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

/**
 * Extract printable ASCII representation
 * @param {Buffer} buffer 
 * @returns {string}
 */
function extractAscii(buffer) {
  if (!buffer || buffer.length === 0) return '';
  let str = '';
  for (let i = 0; i < buffer.length; i++) {
    const code = buffer[i];
    if (code >= 32 && code <= 126) {
      str += String.fromCharCode(code);
    } else if (code === 10) {
      str += '\\n';
    } else if (code === 13) {
      str += '\\r';
    } else {
      str += '.';
    }
  }
  return str;
}

const MODBUS_FUNCTION_NAMES = {
  0x01: 'Read Coils (0x01)',
  0x02: 'Read Discrete Inputs (0x02)',
  0x03: 'Read Holding Registers (0x03)',
  0x04: 'Read Input Registers (0x04)',
  0x05: 'Write Single Coil (0x05)',
  0x06: 'Write Single Register (0x06)',
  0x0F: 'Write Multiple Coils (0x0F)',
  0x10: 'Write Multiple Registers (0x10)'
};

/**
 * Attempt to decode Modbus RTU frame
 * @param {Buffer} buffer 
 * @returns {object|null}
 */
function decodeModbusRTU(buffer) {
  if (!buffer || buffer.length < 4) {
    return null;
  }

  // Modbus RTU CRC is at the last 2 bytes (Low byte first, High byte second)
  const dataLen = buffer.length - 2;
  const payloadForCrc = buffer.subarray(0, dataLen);
  const expectedCrc = calculateCRC16(payloadForCrc);

  const receivedCrcLow = buffer[buffer.length - 2];
  const receivedCrcHigh = buffer[buffer.length - 1];
  const receivedCrc = (receivedCrcHigh << 8) | receivedCrcLow;

  const isCrcValid = expectedCrc === receivedCrc;

  if (!isCrcValid) {
    return null; // Not a valid Modbus RTU packet
  }

  const slaveId = buffer[0];
  const functionCode = buffer[1];
  const isException = (functionCode & 0x80) !== 0;

  if (isException) {
    const exceptionCode = buffer[2];
    return {
      protocol: 'Modbus RTU',
      slaveId,
      functionCode: functionCode & 0x7F,
      isException: true,
      exceptionCode,
      crcValid: true
    };
  }

  const fnName = MODBUS_FUNCTION_NAMES[functionCode] || `Unknown Function (0x${functionCode.toString(16).padStart(2, '0')})`;

  const result = {
    protocol: 'Modbus RTU',
    slaveId,
    functionCode,
    functionName: fnName,
    crcValid: true,
    crc: `0x${receivedCrc.toString(16).padStart(4, '0').toUpperCase()}`
  };

  // Check if it's a response with byte count (Functions 01, 02, 03, 04)
  if ([0x01, 0x02, 0x03, 0x04].includes(functionCode) && buffer.length >= 5) {
    const byteCount = buffer[2];
    if (buffer.length === 3 + byteCount + 2) {
      result.type = 'Response';
      result.byteCount = byteCount;
      const dataBytes = buffer.subarray(3, 3 + byteCount);

      if ([0x03, 0x04].includes(functionCode)) {
        // 16-bit registers
        const registers = [];
        for (let i = 0; i < dataBytes.length; i += 2) {
          if (i + 1 < dataBytes.length) {
            const val = (dataBytes[i] << 8) | dataBytes[i + 1];
            registers.push(val);
          }
        }
        result.registers = registers;

        // Also decode pairs into 32-bit floats if multiple registers
        if (registers.length >= 2) {
          const floats = [];
          for (let i = 0; i < dataBytes.length; i += 4) {
            if (i + 3 < dataBytes.length) {
              const f = dataBytes.readFloatBE(i);
              floats.push(parseFloat(f.toFixed(3)));
            }
          }
          if (floats.length > 0) result.floats = floats;
        }
      } else {
        // Coils / discrete inputs
        result.coilBytes = Array.from(dataBytes);
      }
      return result;
    }
  }

  // Check if it's a request (e.g. Read Registers: Slave(1), Fn(1), StartAddr(2), Count(2), CRC(2) = 8 bytes)
  if ([0x01, 0x02, 0x03, 0x04].includes(functionCode) && buffer.length === 8) {
    result.type = 'Request / Poll';
    result.startAddress = (buffer[2] << 8) | buffer[3];
    result.quantity = (buffer[4] << 8) | buffer[5];
    return result;
  }

  // Write single register / coil (8 bytes)
  if ([0x05, 0x06].includes(functionCode) && buffer.length === 8) {
    result.type = 'Write Request';
    result.address = (buffer[2] << 8) | buffer[3];
    result.value = (buffer[4] << 8) | buffer[5];
    return result;
  }

  return result;
}

/**
 * Check if the payload is a known PUSR heartbeat packet
 * Default PUSR heartbeat is often "www.usr.cn" or custom configured strings like "HEARTBEAT"
 * @param {Buffer} buffer 
 * @returns {boolean}
 */
function isHeartbeatPacket(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const str = buffer.toString('utf8').trim();
  const hex = formatHex(buffer).toLowerCase();

  // Common default PUSR heartbeats
  if (str === 'www.usr.cn' || str === 'heartbeat' || str === 'HEARTBEAT' || str === 'ping' || str === 'PING') {
    return true;
  }
  // Hex equivalent of "www.usr.cn" -> 77 77 77 2e 75 73 72 2e 63 6e
  if (hex === '77 77 77 2e 75 73 72 2e 63 6e') {
    return true;
  }
  return false;
}

/**
 * Helper to build a Modbus RTU Read Holding Registers request frame
 * @param {number} slaveId 
 * @param {number} startAddress 
 * @param {number} quantity 
 * @returns {Buffer}
 */
function buildModbusReadRequest(slaveId = 1, startAddress = 0, quantity = 2) {
  const buf = Buffer.alloc(8);
  buf[0] = slaveId & 0xFF;
  buf[1] = 0x03; // Read holding registers
  buf[2] = (startAddress >> 8) & 0xFF;
  buf[3] = startAddress & 0xFF;
  buf[4] = (quantity >> 8) & 0xFF;
  buf[5] = quantity & 0xFF;
  const crc = calculateCRC16(buf.subarray(0, 6));
  buf[6] = crc & 0xFF;        // CRC Low byte
  buf[7] = (crc >> 8) & 0xFF; // CRC High byte
  return buf;
}

module.exports = {
  calculateCRC16,
  formatHex,
  extractAscii,
  decodeModbusRTU,
  isHeartbeatPacket,
  buildModbusReadRequest
};
