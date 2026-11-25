// Minimal NDJSON client for exercising fleet-computer-use.exe by hand and from smoke scripts.
import { spawn } from "node:child_process";

export class Helper {
  constructor(exe) {
    this.child = spawn(exe, [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.buffer = "";
    this.exited = new Promise((resolve) => this.child.once("close", (code) => resolve(code)));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        const msg = JSON.parse(line);
        if (msg.event) { this.events.push(msg); continue; }
        const wait = this.pending.get(msg.id);
        if (wait) { this.pending.delete(msg.id); wait(msg); }
      }
    });
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async stop() { await this.send("shutdown").catch(() => {}); this.child.stdin.end(); return this.exited; }
}
