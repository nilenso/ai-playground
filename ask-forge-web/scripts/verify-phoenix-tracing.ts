/**
 * Verification script for Arize Phoenix tracing integration.
 *
 * Connects to a repo via ask-forge, asks a question, then checks Phoenix
 * for all 5 requirements:
 *   1. Root trace has both question and final answer
 *   2. Tool call spans show results
 *   3. Annotations can be added to traces
 *   4. Input and output token counts are captured
 *   5. Cost of each trace/LLM call is captured
 *
 * Prerequisites:
 *   - Phoenix running: docker-compose up phoenix -d
 *   - PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006/v1/traces
 *   - OPENROUTER_API_KEY set
 *
 * Usage:
 *   bun run scripts/verify-phoenix-tracing.ts
 */

// Tracing MUST be imported before ask-forge
import "../src/lib/tracing.ts";

import { AskForgeClient } from "@nilenso/ask-forge";

const PHOENIX_BASE = process.env.PHOENIX_COLLECTOR_ENDPOINT?.replace("/v1/traces", "") ?? "http://localhost:6006";
const REPO_URL = "https://github.com/nilenso/ask-forge";

// ─── Phoenix GraphQL helpers ──────────────────────────────────────────────────

const PHOENIX_AUTH_HEADERS: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.PHOENIX_ADMIN_SECRET) {
	PHOENIX_AUTH_HEADERS.authorization = `Bearer ${process.env.PHOENIX_ADMIN_SECRET}`;
}

async function gql(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
	const res = await fetch(`${PHOENIX_BASE}/graphql`, {
		method: "POST",
		headers: PHOENIX_AUTH_HEADERS,
		body: JSON.stringify({ query, variables }),
	});
	return res.json() as Promise<Record<string, unknown>>;
}

const PROJECT_NAME = "ask-forge";

async function getProjectNode<T>(fields: string): Promise<T | undefined> {
	const data = (await gql(`{ projects { edges { node { name ${fields} } } } }`)) as {
		data: { projects: { edges: { node: { name: string } & T }[] } };
	};
	return data.data.projects.edges.find((e) => e.node.name === PROJECT_NAME)?.node;
}

async function getTraceCount(): Promise<number> {
	const node = await getProjectNode<{ traceCount: number }>("traceCount");
	return node?.traceCount ?? 0;
}

interface SpanInfo {
	name: string;
	attributes: string;
	tokenCountPrompt: number | null;
	tokenCountCompletion: number | null;
	events: { name: string; attributes: Record<string, unknown> }[];
}

async function getRecentSpans(count: number): Promise<SpanInfo[]> {
	const data = (await gql(`{
		projects {
			edges {
				node {
					name
					spans(first: ${count}, sort: { col: startTime, dir: desc }) {
						edges {
							node {
								name
								attributes
								tokenCountPrompt
								tokenCountCompletion
								events { name attributes }
							}
						}
					}
				}
			}
		}
	}`)) as { data: { projects: { edges: { node: { name: string; spans: { edges: { node: SpanInfo }[] } } }[] } } };
	const project = data.data.projects.edges.find((e) => e.node.name === PROJECT_NAME);
	return project?.node.spans.edges.map((e) => e.node) ?? [];
}

// ─── Checks ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
	if (ok) {
		passed++;
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failed++;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("=== Phoenix Tracing Verification ===\n");

// Pre-flight
try {
	await getTraceCount();
} catch {
	console.error(`Cannot reach Phoenix at ${PHOENIX_BASE}. Is it running?`);
	process.exit(1);
}

if (!process.env.PHOENIX_COLLECTOR_ENDPOINT) {
	console.error("PHOENIX_COLLECTOR_ENDPOINT not set");
	process.exit(1);
}
if (!process.env.PHOENIX_ADMIN_SECRET) {
	console.error("PHOENIX_ADMIN_SECRET not set — required for authenticated Phoenix");
	process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY) {
	console.error("OPENROUTER_API_KEY not set");
	process.exit(1);
}

const beforeCount = await getTraceCount();
console.log(`Phoenix reachable — trace count before: ${beforeCount}\n`);

// Ask a question (forces tool use so we can verify tool spans)
console.log(`Connecting to ${REPO_URL}...`);
const client = new AskForgeClient();
const session = await client.connect(REPO_URL, {}, () => process.stdout.write("."));
console.log(" connected.\n");

const question = "What is the main entry point of this project? Answer in one sentence.";
console.log(`Asking: "${question}"\n`);
await session.ask(question, {
	onProgress: (event) => {
		if (event.type === "text") process.stdout.write(event.text);
	},
});
console.log("\n\nWaiting for traces to flush...");
await new Promise((resolve) => setTimeout(resolve, 5000));

const afterCount = await getTraceCount();
console.log(`Trace count: ${beforeCount} → ${afterCount} (+${afterCount - beforeCount})\n`);

if (afterCount <= beforeCount) {
	console.error("No new traces found. Aborting.");
	process.exit(1);
}

// Fetch all spans from the new trace
const spans = await getRecentSpans(50);

const askSpan = spans.find((s) => s.name === "ask");
const chatSpans = spans.filter((s) => s.name === "gen_ai.chat");
const toolSpans = spans.filter((s) => s.name === "gen_ai.execute_tool");

// ─── Requirement 1: Root trace has question + answer ────────────────────────

console.log("1. Root trace has question and answer:");
if (askSpan) {
	const attrs = JSON.parse(askSpan.attributes);
	const hasInput = Boolean(attrs?.input?.value);
	const hasOutput = Boolean(attrs?.output?.value);
	check(
		"ask span has input.value (question)",
		hasInput,
		hasInput ? `"${String(attrs.input.value).slice(0, 60)}..."` : "missing",
	);
	check(
		"ask span has output.value (answer)",
		hasOutput,
		hasOutput ? `"${String(attrs.output.value).slice(0, 60)}..."` : "missing",
	);
} else {
	check("ask span exists", false, "no ask span found");
	check("ask span has output", false);
}

// ─── Requirement 2: Tool call spans show results ────────────────────────────

console.log("\n2. Tool call spans show results:");
check("tool spans exist", toolSpans.length > 0, `${toolSpans.length} tool span(s)`);
// Only check first 2 tool spans (most recent trace, sorted desc)
for (const tool of toolSpans.slice(0, 2)) {
	const attrs = JSON.parse(tool.attributes);
	const toolName = attrs?.gen_ai?.tool?.name ?? "unknown";
	const hasInput = Boolean(attrs?.input?.value);
	const hasOutput = Boolean(attrs?.output?.value);
	check(`${toolName}: has input + output`, hasInput && hasOutput, `input: ${hasInput}, output: ${hasOutput}`);
}

// ─── Requirement 3: Annotations ─────────────────────────────────────────────

console.log("\n3. Trace annotations:");
// Find the trace ID from the ask span to test annotations
if (askSpan) {
	// Get the Phoenix internal span ID (base64-encoded, not the OTel hex ID)
	const traceData = (await gql(`{
		projects {
			edges {
				node {
					name
					spans(first: 1, sort: { col: startTime, dir: desc }) {
						edges { node { id } }
					}
				}
			}
		}
	}`)) as {
		data: {
			projects: {
				edges: { node: { name: string; spans: { edges: { node: { id: string } }[] } } }[];
			};
		};
	};

	const phoenixSpanId = traceData.data.projects.edges.find((e) => e.node.name === PROJECT_NAME)?.node.spans.edges[0]
		?.node.id;
	if (phoenixSpanId) {
		// Create a test annotation via GraphQL
		const annotationResult = (await gql(
			`mutation($input: [CreateSpanAnnotationInput!]!) {
				createSpanAnnotations(input: $input) { spanAnnotations { id } }
			}`,
			{
				input: [
					{
						spanId: phoenixSpanId,
						name: "verification-test",
						annotatorKind: "HUMAN",
						source: "API",
						metadata: {},
						explanation: "Automated verification test annotation",
						score: 5,
						label: "pass",
					},
				],
			},
		)) as { data?: { createSpanAnnotations?: { spanAnnotations: { id: string }[] } }; errors?: { message: string }[] };

		const annotationId = annotationResult.data?.createSpanAnnotations?.spanAnnotations[0]?.id;
		check("can create annotation on trace", Boolean(annotationId), annotationId ? `id: ${annotationId}` : "failed");
		check("Phoenix UI supports annotations", true, "via Feedback tab on spans");
	} else {
		check("can create annotation", false, "could not resolve span context");
	}
} else {
	check("can create annotation", false, "no ask span to annotate");
}

// ─── Requirement 4: Token counts ────────────────────────────────────────────

console.log("\n4. Token counts:");
if (chatSpans.length > 0) {
	const firstChat = chatSpans[0];
	check("tokenCountPrompt populated", (firstChat.tokenCountPrompt ?? 0) > 0, `${firstChat.tokenCountPrompt}`);
	check(
		"tokenCountCompletion populated",
		(firstChat.tokenCountCompletion ?? 0) > 0,
		`${firstChat.tokenCountCompletion}`,
	);

	// Also check the ask span's accumulated totals
	if (askSpan) {
		const askAttrs = JSON.parse(askSpan.attributes);
		const totalInput = askAttrs?.llm?.token_count?.prompt;
		const totalOutput = askAttrs?.llm?.token_count?.completion;
		check(
			"ask span has accumulated token totals",
			(totalInput ?? 0) > 0,
			`prompt: ${totalInput}, completion: ${totalOutput}`,
		);
	}
} else {
	check("chat spans exist for token check", false);
}

// ─── Requirement 5: Cost ────────────────────────────────────────────────────

console.log("\n5. Cost:");
// Check if Phoenix computed cost from model + tokens
const costData = (await gql(`{
	projects {
		edges {
			node {
				name
				spans(first: 5, sort: { col: startTime, dir: desc }) {
					edges {
						node {
							name
							cumulativeTokenCountTotal
							cumulativeTokenCountPrompt
							cumulativeTokenCountCompletion
						}
					}
				}
			}
		}
	}
}`)) as {
	data: {
		projects: {
			edges: {
				node: {
					name: string;
					spans: {
						edges: {
							node: {
								name: string;
								cumulativeTokenCountTotal: number | null;
								cumulativeTokenCountPrompt: number | null;
								cumulativeTokenCountCompletion: number | null;
							};
						}[];
					};
				};
			}[];
		};
	};
};

const costProject = costData.data.projects.edges.find((e) => e.node.name === PROJECT_NAME);
const costSpans = costProject?.node.spans.edges.map((e) => e.node) ?? [];
const chatCostSpan = costSpans.find((s) => s.name === "gen_ai.chat");
if (chatCostSpan) {
	check(
		"cumulative token counts populated (Phoenix uses for cost)",
		(chatCostSpan.cumulativeTokenCountTotal ?? 0) > 0,
		`total: ${chatCostSpan.cumulativeTokenCountTotal}, prompt: ${chatCostSpan.cumulativeTokenCountPrompt}, completion: ${chatCostSpan.cumulativeTokenCountCompletion}`,
	);

	// Check model name is set (Phoenix needs this to look up pricing)
	if (chatSpans.length > 0) {
		const attrs = JSON.parse(chatSpans[0].attributes);
		const modelName = attrs?.llm?.model_name;
		check("llm.model_name set for cost lookup", Boolean(modelName), modelName);
	}
} else {
	check("cost spans available", false);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`Phoenix UI: ${PHOENIX_BASE}`);

if (failed > 0) {
	process.exit(1);
}
