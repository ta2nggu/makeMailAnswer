const tls = require('tls');

class POP3Client {
  constructor({ host, port, user, password }) {
    this.host = host;
    this.port = port || 995;
    this.user = user;
    this.password = password;
    this.socket = null;
    this.buffer = '';
    this.currentCommand = null;
    this.resolver = null;
    this.rejecter = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect({
        host: this.host,
        port: this.port,
        rejectUnauthorized: false // Avoid SSL certificate handshake issues if any
      }, () => {
        // Connected
      });

      this.socket.setEncoding('utf-8');

      this.socket.on('data', (data) => {
        this.buffer += data;
        this.handleData();
      });

      this.socket.on('error', (err) => {
        if (this.rejecter) {
          this.rejecter(err);
        } else {
          reject(err);
        }
      });

      this.socket.on('close', () => {
        // Socket closed
      });

      // The greeting event (+OK ...)
      this.resolver = (greeting) => {
        resolve(greeting);
      };
      this.rejecter = reject;
    });
  }

  handleData() {
    if (!this.resolver) return;

    if (this.currentCommand && this.currentCommand.multiline) {
      // Multiline responses end with \r\n.\r\n
      const endMarker = '\r\n.\r\n';
      const index = this.buffer.indexOf(endMarker);
      if (index !== -1) {
        const response = this.buffer.substring(0, index + endMarker.length);
        this.buffer = this.buffer.substring(index + endMarker.length);
        
        const resolve = this.resolver;
        this.resolver = null;
        this.rejecter = null;
        this.currentCommand = null;
        resolve(response);
      }
    } else {
      // Single line responses end with \r\n
      const index = this.buffer.indexOf('\r\n');
      if (index !== -1) {
        const response = this.buffer.substring(0, index + 2);
        this.buffer = this.buffer.substring(index + 2);

        if (response.startsWith('-ERR')) {
          const reject = this.rejecter;
          this.resolver = null;
          this.rejecter = null;
          this.currentCommand = null;
          reject(new Error(response.trim()));
        } else {
          const resolve = this.resolver;
          this.resolver = null;
          this.rejecter = null;
          this.currentCommand = null;
          resolve(response);
        }
      }
    }
  }

  sendCommand(cmd, multiline = false) {
    return new Promise((resolve, reject) => {
      this.resolver = resolve;
      this.rejecter = reject;
      this.currentCommand = { cmd, multiline };
      this.socket.write(cmd + '\r\n');
    });
  }

  async login() {
    await this.sendCommand(`USER ${this.user}`);
    await this.sendCommand(`PASS ${this.password}`);
  }

  async getStat() {
    const res = await this.sendCommand('STAT');
    // Format: +OK count size
    const parts = res.trim().split(' ');
    const count = parseInt(parts[1], 10);
    const size = parseInt(parts[2], 10);
    return { count, size };
  }

  async getHeader(msgNum) {
    // TOP msgNum 0 fetches headers and 0 lines of the body.
    try {
      const res = await this.sendCommand(`TOP ${msgNum} 0`, true);
      return res;
    } catch (err) {
      // Fallback: If TOP command is not supported by the server, fetch entire mail using RETR
      const res = await this.sendCommand(`RETR ${msgNum}`, true);
      return res;
    }
  }

  async getMail(msgNum) {
    const res = await this.sendCommand(`RETR ${msgNum}`, true);
    return res;
  }

  async getUidl() {
    const res = await this.sendCommand('UIDL', true);
    return res;
  }

  async quit() {
    if (this.socket) {
      try {
        await this.sendCommand('QUIT');
      } catch (e) {
        // Ignore error during quit
      }
      this.socket.end();
    }
  }
}

module.exports = POP3Client;
