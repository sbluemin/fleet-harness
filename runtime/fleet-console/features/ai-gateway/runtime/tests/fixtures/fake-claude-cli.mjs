// `claude auth login` / `claude auth status --json`을 흉내 내는 가짜 CLI. 실제 로그인·Keychain·네트워크를 쓰지 않는다.
// FAKE_CLAUDE_URL: visit: 뒤에 낼 주소, FAKE_CLAUDE_FINAL: 코드를 받은 뒤 종료 코드, FAKE_CLAUDE_LOGGED_IN: status의 loggedIn,
// FAKE_CLAUDE_SIGINT_EXIT: SIGINT를 받았을 때 종료 코드(파이프 실측은 0), FAKE_CLAUDE_LOG: 시작 시 환경을 JSON으로 남길 파일.
import fs from "node:fs";
import readline from "node:readline";

const [group, action] = process.argv.slice(2);
const env = process.env;

if (env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(env.FAKE_CLAUDE_LOG, `${JSON.stringify({
    args: process.argv.slice(2),
    keys: Object.keys(env).filter((key) => key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_") || key === "HOME"),
  })}\n`);
}

if (group === "auth" && action === "status") {
  const loggedIn = env.FAKE_CLAUDE_LOGGED_IN === "1";
  process.stdout.write(`${JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" })}\n`);
  process.exit(loggedIn ? 0 : 1);
}

if (group === "auth" && action === "login") {
  const url = env.FAKE_CLAUDE_URL ?? "https://claude.com/cai/oauth/authorize?code=true&state=s";
  process.on("SIGINT", () => process.exit(Number(env.FAKE_CLAUDE_SIGINT_EXIT ?? 0)));
  process.stdout.write("Opening browser to sign in…\n");
  if (env.FAKE_CLAUDE_NO_URL === "1") {
    setInterval(() => undefined, 1000);
  } else {
    // 터미널이면 하이퍼링크(OSC 8)로 감싸 낸다.
    process.stdout.write(`If the browser didn't open, visit: \u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\\n`);
    process.stdout.write("Paste code here if prompted > ");
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      if (!line.includes("#")) { process.stderr.write("That doesn't look like the full code.\n"); return; }
      if (env.FAKE_CLAUDE_STDIN_LOG) fs.writeFileSync(env.FAKE_CLAUDE_STDIN_LOG, `${line}\n`);
      process.exit(Number(env.FAKE_CLAUDE_FINAL ?? 0));
    });
  }
}
