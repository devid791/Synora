// Harmless, temporary QA reachability control. Never an app or shell service.
import net from "node:net";
import dgram from "node:dgram";
const host = process.argv[2];
if (host !== "10.23.46.16")
  throw Error("Use the explicitly authorized QA VM address");
const reply = "SYNORA_QA_NETWORK_PROBE";
const sockets = new Set();
const tcp = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.end(reply);
});
const udp = dgram.createSocket("udp4");
udp.on("message", (bytes, peer) => {
  if (bytes.toString() === reply) udp.send(reply, peer.port, peer.address);
});
await new Promise((resolve) => tcp.listen(0, host, resolve));
await new Promise((resolve) => udp.bind(0, host, resolve));
console.log(
  JSON.stringify({
    pid: process.pid,
    host,
    tcp: tcp.address().port,
    udp: udp.address().port,
  }),
);
process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  tcp.close();
  udp.close();
});
