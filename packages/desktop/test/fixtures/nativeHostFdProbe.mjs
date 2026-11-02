import { deserialize, serialize } from "node:v8";
import { Socket } from "node:net";

const args = process.argv.slice(2);
const fdIndex = args.indexOf("--host-fd");
const fd = Number(args[fdIndex + 1] ?? 5);
const echoHostId = process.env.NATIVE_HOST_ECHO_HOST_ID === "1";
const socket = new Socket({ fd, readable: true, writable: true });

let buffer = Buffer.alloc(0);
const send = (frame) => {
  const payload = serialize(frame);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
};

send({ v: 1, kind: "hello", hostId: "probe-host" });

socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < 4 + length) return;
    const frame = deserialize(buffer.subarray(4, 4 + length));
    buffer = buffer.subarray(4 + length);
    if (frame.kind === "control") {
      send({
        v: 1,
        kind: "control",
        message: {
          type: "ready",
          ...(echoHostId && typeof frame.message?.hostId === "string"
            ? { hostId: frame.message.hostId }
            : {}),
        },
        portIds: [],
      });
      const portId = frame.portIds[0];
      if (portId !== undefined) {
        send({ v: 1, kind: "port-data", portId, data: { echo: "hello" } });
      }
    } else if (frame.kind === "port-data") {
      send({ v: 1, kind: "port-data", portId: frame.portId, data: { echo: frame.data } });
    } else if (frame.kind === "port-close") {
      send({ v: 1, kind: "port-close", portId: frame.portId });
    }
  }
});

process.on("SIGTERM", () => {
  socket.destroy();
  process.exit(0);
});
