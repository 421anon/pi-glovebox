#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

const stdout = 1;
const exit = 2;
const failure = 3;
const stderr = 4;
// Background processes can hold stdout and stderr open after the command exits. Like Pi's own bash,
// stop waiting for their output once none has arrived for this long.
const quietMs = 100;

const frame = (type, payload) => {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};

net
  .createServer((socket) => {
    const received = [];
    let child;
    let exited = false;
    let finished = false;
    let quiet;

    const finish = (type, payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(quiet);
      socket.end(frame(type, Buffer.from(payload)));
    };

    const finishWhenQuiet = () => {
      clearTimeout(quiet);
      if (finished) return;
      quiet = setTimeout(() => {
        // A paused stream still holds output the client has not taken yet.
        if (child.stdout.isPaused() || child.stderr.isPaused()) return finishWhenQuiet();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(exit, JSON.stringify(child.exitCode));
      }, quietMs);
    };

    const forward = (stream, type) =>
      stream.on("data", (chunk) => {
        if (finished) return;
        if (exited) finishWhenQuiet();
        if (socket.write(frame(type, chunk))) return;
        stream.pause();
        socket.once("drain", () => stream.resume());
      });

    socket.on("error", () => {});
    socket.on("close", () => {
      if (finished) return;
      finished = true;
      clearTimeout(quiet);
      if (!child) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      // Drain what the killed processes left behind so the child can be reaped.
      child.stdout.resume();
      child.stderr.resume();
    });

    socket.on("data", function onRequest(chunk) {
      const end = chunk.indexOf(10);
      if (end < 0) return void received.push(chunk);
      received.push(chunk.subarray(0, end));
      socket.off("data", onRequest);

      let request;
      try {
        request = JSON.parse(Buffer.concat(received).toString());
      } catch {}
      const valid =
        Array.isArray(request?.argv) &&
        request.argv.length > 0 &&
        request.argv.every((arg) => typeof arg === "string") &&
        typeof request.cwd === "string" &&
        (request.stdin === undefined || typeof request.stdin === "string");
      if (!valid) return socket.destroy();
      if (!existsSync(request.cwd)) return finish(failure, `Working directory does not exist: ${request.cwd}`);
      try {
        child = spawn(request.argv[0], request.argv.slice(1), { cwd: request.cwd, detached: true });
      } catch (error) {
        return finish(failure, error.message);
      }
      forward(child.stdout, stdout);
      forward(child.stderr, stderr);
      child.on("error", (error) => finish(failure, error.message));
      child.on("exit", () => {
        exited = true;
        finishWhenQuiet();
      });
      child.on("close", (code) => finish(exit, JSON.stringify(code)));
      child.stdin.on("error", () => {});
      child.stdin.end(request.stdin ?? "");
    });
  })
  .listen(process.argv[2]);
