#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";

const output = 1;
const exit = 2;

const frame = (type, payload) => {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};

net
  .createServer((socket) => {
    let received = Buffer.alloc(0);
    let child;
    let exited = false;

    const finish = (code) => {
      if (exited) return;
      exited = true;
      socket.end(frame(exit, Buffer.from(JSON.stringify(code))));
    };

    const forward = (stream) =>
      stream.on("data", (chunk) => {
        if (socket.write(frame(output, chunk))) return;
        stream.pause();
        socket.once("drain", () => stream.resume());
      });

    socket.on("error", () => {});
    socket.on("close", () => {
      if (!child || exited) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    });

    socket.on("data", function onRequest(chunk) {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf(10);
      if (end < 0) return;
      socket.off("data", onRequest);

      let request;
      try {
        request = JSON.parse(received.subarray(0, end).toString());
      } catch {}
      const valid =
        Array.isArray(request?.argv) &&
        request.argv.length > 0 &&
        request.argv.every((arg) => typeof arg === "string") &&
        typeof request.cwd === "string" &&
        (request.stdin === undefined || typeof request.stdin === "string");
      if (!valid) return socket.destroy();
      try {
        child = spawn(request.argv[0], request.argv.slice(1), { cwd: request.cwd, detached: true });
      } catch (error) {
        socket.write(frame(output, Buffer.from(`${error.message}\n`)));
        return finish(null);
      }
      forward(child.stdout);
      forward(child.stderr);
      child.on("error", (error) => {
        socket.write(frame(output, Buffer.from(`${error.message}\n`)));
        finish(null);
      });
      child.on("close", (code) => finish(code));
      child.stdin.on("error", () => {});
      child.stdin.end(request.stdin ?? "");
    });
  })
  .listen(process.argv[2]);
