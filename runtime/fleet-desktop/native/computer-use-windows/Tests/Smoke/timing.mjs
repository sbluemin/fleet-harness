import { Helper } from "./helper-client.mjs";
const h = new Helper(process.argv[2]);
let t = Date.now(); await h.send("hello"); console.log("hello", Date.now() - t);
for (let i = 0; i < 3; i++) { t = Date.now(); const w = await h.send("windows"); console.log("windows", Date.now() - t, w.result.windows.length); }
t = Date.now(); await h.send("windows", { query: "메모장" }); console.log("windows+query", Date.now() - t);
t = Date.now(); console.log("exit", await h.stop(), Date.now() - t);
