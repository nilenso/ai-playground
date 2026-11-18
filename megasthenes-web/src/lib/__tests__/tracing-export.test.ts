import { expect, test } from "bun:test";

// Use a child process to avoid leaking the global OTel provider into other tests.
test("tracing exports enriched OTLP protobuf to a dummy Phoenix collector", async () => {
	const requests: { path: string; authorization: string | null; type: string | null; body: string }[] = [];
	const collector = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push({
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
				type: request.headers.get("content-type"),
				body: Buffer.from(await request.arrayBuffer()).toString(),
			});
			return new Response(new Uint8Array(), { headers: { "content-type": "application/x-protobuf" } });
		},
	});
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`await import("./src/lib/tracing.ts");
			const { trace } = await import("@opentelemetry/api");
			const span = trace.getTracer("security-regression").startSpan("gen_ai.chat", {
				attributes: { "gen_ai.request.model": "dummy/provider/test-model", "gen_ai.usage.input_tokens": 3 }
			});
			span.end();
			await trace.getTracerProvider().getDelegate().forceFlush();
			await trace.getTracerProvider().getDelegate().shutdown();`,
		],
		{
			cwd: process.cwd(),
			env: {
				PATH: process.env.PATH,
				PHOENIX_COLLECTOR_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/traces`,
				PHOENIX_ADMIN_SECRET: "dummy-collector-token",
				OTEL_METRICS_EXPORTER: "none",
				OTEL_LOGS_EXPORTER: "none",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(stderr).toBe("");
		expect(exit).toBe(0);
		expect(requests).toHaveLength(1);
		const request = requests[0];
		if (!request) throw new Error("Collector received no trace export");
		expect(request.path).toBe("/v1/traces");
		expect(request.authorization).toBe("Bearer dummy-collector-token");
		expect(request.type).toBe("application/x-protobuf");
		for (const value of ["gen_ai.chat", "llm.model_name", "test-model", "llm.token_count.prompt"]) {
			expect(request.body).toContain(value);
		}
	} finally {
		child.kill();
		await collector.stop(true);
	}
}, 10000);
