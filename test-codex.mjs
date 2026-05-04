import { spawn } from "child_process";

const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", "codex app-server"],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    windowsHide: true
  }
);

child.stdout.on("data", (data) => console.log(`STDOUT: ${data.toString()}`));
child.stderr.on("data", (data) => console.error(`STDERR: ${data.toString()}`));
child.on("exit", (code) => console.log(`EXIT: ${code}`));

let id = 1;
function send(method, params) {
  const msg = JSON.stringify({ id: id++, method, params });
  console.log(`SENDING: ${msg}`);
  child.stdin.write(msg + "\n");
}

send("initialize", { clientInfo: { name: "test", version: "1" } });
send("thread/start", { title: "Test", cwd: process.cwd() });
// We'll wait a bit for thread/start to return
setTimeout(() => {
  send("turn/start", {
    threadId: "some-thread-id",
    cwd: process.cwd(),
    input: [{ type: "text", text: "Hello" }]
  });
}, 1000);

setTimeout(() => {
  send("turn/start", {
    threadId: "some-thread-id",
    cwd: process.cwd(),
    input: [{ type: "message", text: "Hello" }]
  });
}, 1500);

setTimeout(() => {
  send("turn/start", {
    threadId: "some-thread-id",
    cwd: process.cwd(),
    input: [{ type: "user", text: "Hello" }]
  });
}, 2000);

setTimeout(() => {
  child.kill();
}, 2500);
