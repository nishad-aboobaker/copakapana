import net from 'net';

export class TcpPrinter {
  /**
   * Sends ESC/POS raw bytes over TCP port 9100 to the thermal printer
   * with a 5000ms timeout
   */
  public static printRaw(ip: string, buffer: Buffer, port = 9100): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let isDone = false;

      socket.setTimeout(5000);

      socket.connect(port, ip, () => {
        socket.write(buffer, () => {
          socket.end();
        });
      });

      socket.on('close', () => {
        if (!isDone) {
          isDone = true;
          resolve();
        }
      });

      socket.on('timeout', () => {
        socket.destroy();
        if (!isDone) {
          isDone = true;
          reject(new Error(`Connection timeout after 5000ms to printer ${ip}:${port}`));
        }
      });

      socket.on('error', (err) => {
        socket.destroy();
        if (!isDone) {
          isDone = true;
          reject(err);
        }
      });
    });
  }
}
