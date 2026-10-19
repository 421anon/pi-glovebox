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

test("gives commands the server environment and ignores any environment in the request", async () => {
	const { socket, output } = await firstOutput({
		argv: ["sh", "-c", 'echo "${PI_GLOVEBOX_SERVER_ONLY-unset} ${PI_GLOVEBOX_CLIENT_ONLY-unset}"'],
		env: { PI_GLOVEBOX_CLIENT_ONLY: "client-value" },
	});
	socket.destroy();
	assert.equal(output, "server-value unset\n");
});

test("kills the whole process group when the client disconnects", async () => {
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
