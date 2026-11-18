import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { getUri } from "get-uri";

// Exercise the get-uri -> basic-ftp override through a real, loopback-only FTP server.
async function ftpFixture(separateHost = false, fallbackListing = false) {
	const sockets = new Set<Socket>();
	let dataSocket: Socket | undefined;
	const track = (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	};
	const data = createServer((socket) => {
		track(socket);
		dataSocket = socket;
	});
	data.listen(0, "127.0.0.1");
	await once(data, "listening");
	const dataAddress = data.address();
	if (!dataAddress || typeof dataAddress === "string") throw new Error("Missing data port");
	const commands: string[] = [];
	const control = createServer((socket) => {
		track(socket);
		socket.write("220 Dummy FTP ready\r\n");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			while (buffer.includes("\r\n")) {
				const end = buffer.indexOf("\r\n");
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const command = line.split(" ")[0] ?? "";
				commands.push(command);
				switch (command) {
					case "USER":
						socket.write("331 Password required\r\n");
						break;
					case "PASS":
						socket.write("230 Logged in\r\n");
						break;
					case "FEAT":
					case "EPSV":
						socket.write("502 Not supported\r\n");
						break;
					case "MDTM":
						socket.write(fallbackListing ? "502 Use LIST\r\n" : "213 20261111000000\r\n");
						break;
					case "PASV": {
						const host = separateHost ? "192,0,2,1" : "127,0,0,1";
						const port = dataAddress.port;
						socket.write(`227 Entering Passive Mode (${host},${port >> 8},${port & 255})\r\n`);
						break;
					}
					case "LIST":
					case "RETR":
						socket.write("150 Opening data connection\r\n");
						if (!dataSocket) throw new Error("Missing passive data connection");
						dataSocket.end(
							command === "LIST" ? "type=file;size=18;modify=20261111000000; proxy.pac\r\n" : "dummy PAC contents",
						);
						socket.write("226 Transfer complete\r\n");
						break;
					case "QUIT":
						socket.end("221 Goodbye\r\n");
						break;
					default:
						socket.write("200 OK\r\n");
				}
			}
		});
	});
	control.listen(0, "127.0.0.1");
	await once(control, "listening");
	const address = control.address();
	if (!address || typeof address === "string") throw new Error("Missing control port");
	return {
		url: `ftp://dummy:dummy@127.0.0.1:${address.port}/proxy.pac`,
		commands,
		close() {
			for (const socket of sockets) socket.destroy();
			control.close();
			data.close();
		},
	};
}

for (const fallbackListing of [false, true]) {
	test(`get-uri retrieves FTP with basic-ftp 6 (LIST fallback: ${fallbackListing})`, async () => {
		const fixture = await ftpFixture(false, fallbackListing);
		try {
			const stream = await getUri(fixture.url, { timeout: 1000 });
			let body = "";
			for await (const chunk of stream) body += chunk.toString();
			expect(body).toBe("dummy PAC contents");
			expect(fixture.commands).toContain("RETR");
			if (fallbackListing) expect(fixture.commands).toContain("LIST");
		} finally {
			fixture.close();
		}
	});
}

test("get-uri rejects a separate PASV transfer host with basic-ftp 6 defaults", async () => {
	// LIST is awaited by get-uri; downloadTo itself runs after getUri returns its stream.
	const fixture = await ftpFixture(true, true);
	try {
		await expect(getUri(fixture.url, { timeout: 1000 })).rejects.toThrow("PASV returned another host");
		expect(fixture.commands).not.toContain("RETR");
	} finally {
		fixture.close();
	}
});
