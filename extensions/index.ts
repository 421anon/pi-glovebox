import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	detectSupportedImageMimeTypeFromFile,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const socketPath = process.env.PI_GLOVEBOX_SOCKET;
if (!socketPath) throw new Error("PI_GLOVEBOX_SOCKET is not set");

const imageSniffBytes = "4100";
const ownFile = realpathSync(fileURLToPath(import.meta.url));
const ownPaths = [ownFile, path.dirname(ownFile)];
const ownTools = ["bash", "read", "write", "edit"];
// The largest delay setTimeout accepts; Pi's own bash rejects longer timeouts the same way.
const maxTimeoutMs = 2147483647;
const frameStdout = 1;
const frameExit = 2;
const frameFailure = 3;
const frameStderr = 4;

type Request = { argv: string[]; cwd: string; stdin?: string };
type Options = { onData?: (data: Buffer) => void; signal?: AbortSignal; timeout?: number };
type Result = { stdout: Buffer; stderr: Buffer; exitCode: number | null };

const run = (request: Request, { onData, signal, timeout }: Options = {}) =>
	new Promise<Result>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let received = Buffer.alloc(0);
		let exitCode: number | null | undefined;
		let failure: string | undefined;

		const stop = (error: Error) => {
			socket.destroy();
			reject(error);
		};
		const abort = () => stop(new Error("aborted"));
		const timer = timeout ? setTimeout(() => stop(new Error(`timeout:${timeout}`)), timeout * 1000) : undefined;
		signal?.addEventListener("abort", abort, { once: true });

		socket.on("data", (chunk) => {
			received = Buffer.concat([received, chunk]);
			while (received.length >= 5 && received.length >= 5 + received.readUInt32BE(1)) {
				const payload = received.subarray(5, 5 + received.readUInt32BE(1));
				if (received[0] === frameStdout || received[0] === frameStderr) {
					if (onData) onData(payload);
					else (received[0] === frameStdout ? stdout : stderr).push(payload);
				} else if (received[0] === frameExit) {
					exitCode = JSON.parse(payload.toString());
				} else if (received[0] === frameFailure) {
					failure = payload.toString();
				}
				received = received.subarray(5 + payload.length);
			}
		});
		socket.on("error", reject);
		socket.on("close", () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (failure !== undefined) reject(new Error(failure));
			else if (exitCode === undefined) reject(new Error("pi-glovebox: connection closed before the command finished"));
			else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
		});

		if (signal?.aborted) abort();
		else socket.write(`${JSON.stringify(request)}\n`);
	});

// File contents come from stdout alone, so warnings a sandboxed tool prints on stderr never end up in them.
const succeed = async (argv: string[], stdin?: string) => {
	const { stdout, stderr, exitCode } = await run({ argv, cwd: "/", stdin });
	if (exitCode !== 0) throw new Error(stderr.toString().trim() || `exit code ${exitCode}`);
	return stdout;
};

const shell = (script: string, file: string, stdin?: string) =>
	succeed(["bash", "-c", script, "pi-glovebox", file], stdin).then(() => {});

const exec: BashOperations["exec"] = async (command, cwd, { onData, signal, timeout }) => {
	if (timeout !== undefined) {
		if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
		if (timeout * 1000 > maxTimeoutMs) throw new Error(`Invalid timeout: maximum is ${maxTimeoutMs / 1000} seconds`);
	}
	const { exitCode } = await run({ argv: ["bash", "-c", command], cwd }, { onData, signal, timeout });
	return { exitCode };
};

const detectImageMimeType = async (file: string) => {
	const head = await succeed(["head", "-c", imageSniffBytes, "--", file]);
	const directory = await mkdtemp(path.join(tmpdir(), "pi-glovebox-"));
	try {
		await writeFile(path.join(directory, "head"), head);
		return await detectSupportedImageMimeTypeFromFile(path.join(directory, "head"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	pi.on("tool_call", ({ toolName }) => {
		const source = pi.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo;
		if (source?.source === "builtin") {
			return { block: true, reason: `pi-glovebox: ${toolName} is built into Pi and would run outside the sandbox` };
		}
		if (ownTools.includes(toolName) && !(source && existsSync(source.path) && ownPaths.includes(realpathSync(source.path)))) {
			return { block: true, reason: `pi-glovebox: ${toolName} comes from ${source?.path}, not this pi-glovebox (${ownFile}), and would run outside the sandbox` };
		}
	});
	pi.on("user_bash", () => ({ operations: { exec } }));
	// The sandbox gets the server's environment, so the PI_* variables Pi would advertise never reach it.
	pi.registerTool(createBashTool(cwd, { operations: { exec }, exposeSessionEnvironment: false }));
	pi.registerTool(
		createReadTool(cwd, {
			operations: {
				readFile: (file) => succeed(["cat", "--", file]),
				access: (file) => shell(': < "$1"', file),
				detectImageMimeType,
			},
		}),
	);
	pi.registerTool(
		createWriteTool(cwd, {
			operations: {
				writeFile: (file, content) => shell('cat > "$1"', file, content),
				mkdir: (directory) => succeed(["mkdir", "-p", "--", directory]).then(() => {}),
			},
		}),
	);
	pi.registerTool(
		createEditTool(cwd, {
			operations: {
				readFile: (file) => succeed(["cat", "--", file]),
				writeFile: (file, content) => shell('cat > "$1"', file, content),
				access: (file) => shell(': < "$1" && : >> "$1"', file),
			},
		}),
	);
}
