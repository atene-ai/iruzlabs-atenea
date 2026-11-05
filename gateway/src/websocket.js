// The browser's half of a WebSocket, read frame by frame (RFC 6455), so the gateway sees
// the Remote stream requests before dsh's mux does. Only the browser-to-dsh direction is
// read; dsh's frames go back to the browser untouched. No extension is negotiated (the
// gateway removes the offer), so a frame with a reserved bit set is a protocol error.
import { randomBytes } from 'node:crypto'

// dsh buffers at most 256 KiB of uplink per Remote stream; nothing the UI sends is larger.
export const MAX_MESSAGE = 1024 * 1024

export const OPCODE = Object.freeze({ continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 })

export class FrameError extends Error {}

// push(chunk) returns what completed in it, in order: { control } with a control frame's
// bytes as the browser sent them, or { opcode, data } with a whole, unmasked data message.
export function createFrameReader({ maxMessage = MAX_MESSAGE } = {}) {
  let buffer = Buffer.alloc(0)
  let message = null

  function next() {
    if (buffer.length < 2) return undefined
    const first = buffer[0]
    const second = buffer[1]
    if (first & 0x70) throw new FrameError('reserved bits set')
    if (!(second & 0x80)) throw new FrameError('unmasked frame from the browser')
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return undefined
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return undefined
      const long = buffer.readBigUInt64BE(2)
      if (long > BigInt(maxMessage)) throw new FrameError('frame too large')
      length = Number(long)
      offset = 10
    }
    if (length > maxMessage) throw new FrameError('frame too large')
    const start = offset + 4
    if (buffer.length < start + length) return undefined
    const key = buffer.subarray(offset, start)
    const data = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) data[index] = buffer[start + index] ^ key[index & 3]
    const frame = buffer.subarray(0, start + length)
    buffer = buffer.subarray(start + length)
    return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, data, frame }
  }

  return {
    push(chunk) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      const out = []
      for (let frame = next(); frame !== undefined; frame = next()) {
        const { fin, opcode, data } = frame
        if (opcode >= OPCODE.close) {
          if (opcode > OPCODE.pong || !fin || data.length > 125) throw new FrameError('bad control frame')
          out.push({ control: Buffer.from(frame.frame) })
          continue
        }
        if (opcode === OPCODE.continuation) {
          if (message === null) throw new FrameError('continuation without a message')
        } else if (opcode === OPCODE.text || opcode === OPCODE.binary) {
          if (message !== null) throw new FrameError('a new message inside a fragmented one')
          message = { opcode, parts: [], size: 0 }
        } else {
          throw new FrameError(`unknown opcode ${opcode}`)
        }
        message.size += data.length
        if (message.size > maxMessage) throw new FrameError('message too large')
        message.parts.push(data)
        if (fin) {
          out.push({ opcode: message.opcode, data: Buffer.concat(message.parts) })
          message = null
        }
      }
      // Keep only the unread tail, not the whole chunk it sits in.
      if (buffer.length > 0) buffer = Buffer.from(buffer)
      return out
    },
  }
}

// One unfragmented frame as a browser sends it: masked with a fresh key.
export function maskedFrame(opcode, payload) {
  const length = payload.length
  const size = length < 126 ? 2 : length < 65536 ? 4 : 10
  const head = Buffer.alloc(size + 4)
  head[0] = 0x80 | opcode
  if (size === 2) head[1] = 0x80 | length
  else if (size === 4) {
    head[1] = 0x80 | 126
    head.writeUInt16BE(length, 2)
  } else {
    head[1] = 0x80 | 127
    head.writeBigUInt64BE(BigInt(length), 2)
  }
  const key = randomBytes(4)
  key.copy(head, size)
  const body = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) body[index] = payload[index] ^ key[index & 3]
  return Buffer.concat([head, body])
}
