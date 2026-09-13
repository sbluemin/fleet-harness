// Codex 0.154의 실행용 MCP 클라이언트가 추가하는 auth-change capability를 구형 native
// 클라이언트가 디코딩하지 못한다. 이 전용 연결에서만 해당 광고를 제거하며 요청·승인·결과는 유지한다.
// 별도 파일 설치 없이 현재 Node로 실행하므로 소스 실행과 배포 번들이 같은 경로를 사용한다.
export const MACOS_COMPUTER_USE_TRANSPORT = String.raw`
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const child = spawn(process.argv[1], ['mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
const input = new Transform({
  transform(chunk, encoding, done) {
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer) > 24 * 1024 * 1024) return done(new Error('MCP input frame too large'));
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        const experimental = message?.params?.capabilities?.experimental;
        if (message.method === 'initialize' && experimental && typeof experimental === 'object'
          && Object.hasOwn(experimental, 'codex/auth-change')) {
          delete experimental['codex/auth-change'];
          if (Object.keys(experimental).length === 0) delete message.params.capabilities.experimental;
          line = JSON.stringify(message);
        }
      } catch { /* native가 원래 오류를 처리하도록 변경 없이 전달한다. */ }
      this.push(line + '\n');
    }
    done();
  },
  flush(done) { if (buffer) this.push(buffer); done(); },
});
function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 1500).unref();
}
process.stdin.setEncoding('utf8');
process.stdin.pipe(input).pipe(child.stdin);
child.stdout.pipe(process.stdout);
input.on('error', stop);
child.stdin.on('error', stop);
process.stdout.on('error', stop);
child.on('error', () => { process.exitCode = 1; process.stdin.destroy(); });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); process.stdin.destroy(); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`;
