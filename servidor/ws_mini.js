'use strict';
/* Servidor WebSocket mínimo (norma RFC 6455), sin librerías externas: solo lo que necesita el juego
   (mensajes de texto, ping/pong para detectar conexiones muertas y cierre ordenado).
   Así el servidor funciona con Node.js tal cual, sin «npm install». */
const crypto = require('crypto');
const EventEmitter = require('events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn extends EventEmitter {
  constructor(sock, maxPayload) {
    super();
    this.sock = sock; this.max = maxPayload;
    this.buf = Buffer.alloc(0); this.frag = null; this.fragLen = 0; this.fragOp = 0;
    this.open = true; this.closing = false; this.alive = true;
    sock.setNoDelay(true);
    sock.on('data', (d) => { try { this._data(d); } catch (e) { this._fail(1011); } });
    sock.on('close', () => this._closed());
    sock.on('error', () => {});          // después siempre llega 'close'
  }
  get readyState() { return this.open && !this.closing ? 1 : 3; }

  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, rsv = b[0] & 0x70, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (rsv) return this._fail(1002);            // no se negocian extensiones (sin compresión)
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2) !== 0) return this._fail(1009); len = b.readUInt32BE(6); off = 10; }
      if (!masked) return this._fail(1002);         // el cliente siempre enmascara
      if (len > this.max) return this._fail(1009);
      if (b.length < off + 4 + len) return;         // falta por llegar el resto del mensaje
      const mask = b.subarray(off, off + 4); off += 4;
      const pl = Buffer.from(b.subarray(off, off + len));
      for (let i = 0; i < pl.length; i++) pl[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);
      this._frame(fin, op, pl);
    }
  }

  _frame(fin, op, pl) {
    if (op >= 8) {                                  // mensajes de control
      if (!fin || pl.length > 125) return this._fail(1002);
      if (op === 8) {                               // cierre
        if (!this.closing) { this._send(8, pl.length >= 2 ? pl.subarray(0, 2) : Buffer.alloc(0), true); this.closing = true; }
        this.sock.end();
        return;
      }
      if (op === 9) { this._send(10, pl); return; } // ping → pong
      if (op === 10) { this.alive = true; return; } // pong
      return this._fail(1002);
    }
    if (this.closing) return;
    if (op === 0) {                                 // continuación de un mensaje troceado
      if (!this.frag) return this._fail(1002);
      this.frag.push(pl); this.fragLen += pl.length;
      if (this.fragLen > this.max) return this._fail(1009);
      if (fin) { const all = Buffer.concat(this.frag), t = this.fragOp; this.frag = null; this.fragLen = 0; this._msg(t, all); }
      return;
    }
    if (this.frag) return this._fail(1002);
    if (op === 1 || op === 2) {
      if (fin) this._msg(op, pl);
      else { this.frag = [pl]; this.fragLen = pl.length; this.fragOp = op; }
      return;
    }
    return this._fail(1002);
  }

  _msg(op, pl) { if (op === 1) this.emit('message', pl.toString('utf8')); }   // el juego solo manda texto (JSON)

  _send(op, pl, force) {
    if (!this.open || (this.closing && !force) || this.sock.destroyed) return false;
    const n = pl.length; let h;
    if (n < 126) { h = Buffer.alloc(2); h[1] = n; }
    else if (n < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
    h[0] = 0x80 | op;
    this.sock.write(Buffer.concat([h, pl]));
    return true;
  }
  send(txt) { return this._send(1, Buffer.from(String(txt), 'utf8')); }
  ping() { this._send(9, Buffer.alloc(0)); }
  close(code, reason) {
    if (!this.open || this.closing) return;
    let r = Buffer.from(String(reason || ''), 'utf8'); if (r.length > 120) r = r.subarray(0, 120);
    const pl = Buffer.alloc(2 + r.length); pl.writeUInt16BE(code || 1000, 0); r.copy(pl, 2);
    this._send(8, pl, true); this.closing = true;
    this.sock.end();
    setTimeout(() => this.sock.destroy(), 1500).unref();
  }
  terminate() { this.sock.destroy(); }
  _fail(code) { this.close(code); this.sock.destroy(); }
  _closed() { if (!this.open) return; this.open = false; this.emit('close'); }
}

/* engancha el WebSocket a un servidor http de Node: onConn(conexión, petición) por cada jugador que se conecta */
function attach(httpServer, opts, onConn) {
  const maxPayload = (opts && opts.maxPayload) || (1 << 20);
  httpServer.on('upgrade', (req, sock, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
      sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
    }
    const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    const c = new Conn(sock, maxPayload);
    onConn(c, req);
    if (head && head.length) c._data(head);
  });
}

module.exports = { attach };
