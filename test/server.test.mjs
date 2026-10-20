import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const directory = mkdtempSync(path.join(tmpdir(), "pi-glovebox-test-"));
const socketPath = path.join(directory, "socket");
let server;

before(async () => {
	server = spawn(process.execPath, [new URL("../bin/pi-glovebox-server.mjs", import.meta.url).pathname, socketPath], {
		env: { ...process.env, PI_GLOVEBOX_SERVER_ONLY: "server-value" },
		stdio: "inherit",
	});
	while (!existsSync(socketPath)) await sleep(10);
});

after(() => {
	server.kill("SIGKILL");
	rmSync(directory, { recursive: true, force: true });
});

const firstOutput = async (request) => {
	const socket = net.createConnection(socketPath);
	socket.write(`${JSON.stringify({ cwd: directory, ...request })}\n`);
	const chunk = await new Promise((resolve) => socket.once("data", resolve));
	return { socket, output: chunk.subarray(5).toString() };
};

const frames = async (request, { readAfter = 0 } = {}) => {
	const socket = net.createConnection(socketPath);
	socket.write(`${JSON.stringify({ cwd: directory, ...request })}\n`);
	socket.pause();
	setTimeout(() => socket.resume(), readAfter);
	const chunks = [];
	socket.on("data", (chunk) => chunks.push(chunk));
	await new Promise((resolve) => socket.on("close", resolve));
	const received = Buffer.concat(chunks);
	const result = [];
	for (let offset = 0; offset < received.length; offset += 5 + received.readUInt32BE(offset + 1)) {
		result.push({ type: received[offset], payload: received.subarray(offset + 5, offset + 5 + received.readUInt32BE(offset + 1)) });
	}
	return result;
};

const outputOf = (result) => Buffer.concat(result.filter(({ type }) => type === 1).map(({ payload }) => payload));

test("gives commands the server environment and ignores any environment in the request", async () => {
	const { socket, output } = await firstOutput({
		argv: ["sh", "-c", 'echo "${PI_GLOVEBOX_SERVER_ONLY-unset} ${PI_GLOVEBOX_CLIENT_ONLY-unset}"'],
		env: { PI_GLOVEBOX_CLIENT_ONLY: "client-value" },
	});
	socket.destroy();
	assert.equal(output, "server-value unset\n");
});

test("kills the whole process group when the client disconnects", { skip: !existsSync("/proc/self/stat") && "needs /proc" }, async () => {
	const gone = (pid) => {
		try {
			return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z");
		} catch {
			return true;
		}
	};
	const { socket, output } = await firstOutput({ argv: ["sh", "-c", "sleep 300 & echo $$ $!; wait"] });
	const pids = output.trim().split(" ").map(Number);
	assert.ok(pids.every((pid) => !gone(pid)));
	socket.destroy();
	for (let attempt = 0; attempt < 200 && !pids.every(gone); attempt++) await sleep(10);
	assert.ok(pids.every(gone));
});

test("finishes once the command exits even if a background process keeps its output open", async () => {
	const started = Date.now();
	const result = await frames({ argv: ["sh", "-c", "sleep 30 & echo $!"] });
	process.kill(Number(outputOf(result).toString()));
	assert.ok(Date.now() - started < 5000);
	assert.deepEqual(result.at(-1), { type: 2, payload: Buffer.from("0") });
});

test("keeps background output the client has not read yet", async () => {
	const result = await frames({ argv: ["sh", "-c", "head -c 4000000 /dev/zero &"] }, { readAfter: 500 });
	assert.equal(outputOf(result).length, 4000000);
	assert.deepEqual(result.at(-1), { type: 2, payload: Buffer.from("0") });
});

test("keeps stderr apart from stdout", async () => {
	const result = await frames({ argv: ["sh", "-c", "echo out; echo err >&2; echo more"] });
	assert.equal(outputOf(result).toString(), "out\nmore\n");
	const stderr = Buffer.concat(result.filter(({ type }) => type === 4).map(({ payload }) => payload));
	assert.equal(stderr.toString(), "err\n");
	assert.deepEqual(result.at(-1), { type: 2, payload: Buffer.from("0") });
});

test("reports a command that cannot start as a failure, not an exit code", async () => {
	for (const [request, message] of [
		[{ argv: ["true"], cwd: path.join(directory, "missing") }, `Working directory does not exist: ${path.join(directory, "missing")}`],
		[{ argv: ["pi-glovebox-no-such-command"] }, "spawn pi-glovebox-no-such-command ENOENT"],
	]) {
		assert.deepEqual(await frames(request), [{ type: 3, payload: Buffer.from(message) }]);
	}
});
