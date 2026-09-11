import net from "node:net";
import dgram from "node:dgram";
const [host, tcpText, udpText] = process.argv.slice(2);
if (host !== "10.23.46.16") throw Error("Unexpected QA reachability control");
const message = "SYNORA_QA_NETWORK_PROBE";
const tcp = await new Promise((resolve) => {
  const socket = net.connect({ host, port: Number(tcpText) });
  let output = "";
  const finish = (value) => {
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(1000, () => finish("timeout"));
  socket.on("error", (error) => finish(error.code));
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
  socket.on("error", (error) => finish(error.code));
  socket.on("message", (bytes) =>
    finish(bytes.toString() === message ? "allowed" : "unexpected-reply"),
  );
  socket.connect(Number(udpText), host, () =>
    socket.send(message, (error) => {
      if (error) finish(error.code);
    }),
  );
});
console.log(
  JSON.stringify({
    uid: process.getuid(),
    gid: process.getgid(),
    egid: process.getegid(),
    tcp,
    udp,
  }),
);
