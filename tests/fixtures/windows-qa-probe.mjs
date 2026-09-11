// QA-only TCP/UDP reachability probe. No credentials or model requests.
import net from "node:net";
import dgram from "node:dgram";
const [host, tcpText, udpText] = process.argv.slice(2);
if (host !== "10.23.46.16") throw Error("Unexpected QA reachability control");
for (const p of [tcpText, udpText])
  if (!/^\d+$/.test(p) || +p < 1024 || +p > 65535) throw Error("Invalid port");
const message = "SYNORA_QA_NETWORK_PROBE";
const tcp = await new Promise((resolve) => {
  const socket = net.connect({ host, port: +tcpText });
  let output = "";
  const finish = (value) => {
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(1000, () => finish("timeout"));
  socket.on("error", (e) => finish(e.code));
  socket.on("data", (data) => {
    output += data;
  });
  socket.on("end", () =>
    finish(output === message ? "allowed" : "unexpected-reply"),
  );
});
const udp = await new Promise((resolve) => {
  const socket = dgram.createSocket("udp4");
  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket.close();
    resolve(value);
  };
  const timer = setTimeout(() => finish("timeout"), 1000);
  socket.on("error", (e) => finish(e.code));
  socket.on("message", (bytes) =>
    finish(bytes.toString() === message ? "allowed" : "unexpected-reply"),
  );
  socket.connect(+udpText, host, () =>
    socket.send(message, (e) => {
      if (e) finish(e.code);
    }),
  );
});
console.log(JSON.stringify({ executable: process.execPath, tcp, udp }));
