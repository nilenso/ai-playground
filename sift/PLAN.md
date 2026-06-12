# RAG Research Agent

## Product summary

An internal knowledge-base research agent that lets employees ask natural-language questions and get cited, source-grounded answers — so they trust what they read and can verify it in one click, instead of digging through Confluence or Slack search.

## Top user stories

**1. Ask and verify**
As an employee, I can ask a natural-language question about company information and get back an answer where every claim links to the source document and passage it came from — so I can verify the answer in one click instead of trusting the agent blindly.

**2. Multi-source synthesis**
As an employee, I can ask questions whose answer lives across multiple documents (e.g., "what did the security team decide about X, and how does it affect our Y rollout?") and get a single synthesized answer with citations to each contributing source — so I don't have to manually piece together fragments from different docs.

**3. Honest "I don't know"**
As an employee, when I ask about something the knowledge base doesn't cover, the agent tells me it can't find the answer instead of hallucinating one — so I learn to trust it for the things it *does* answer.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Vector DB | **Qdrant** (embedded, then server) | Native sparse + dense + RRF in one Query API call; payload-aware HNSW; same code embedded → cloud |
| Embedder | **`BAAI/bge-small-en-v1.5`** via fastembed; optional `BGE_MODEL=BAAI/bge-m3` | Local default; the `Embedder` Protocol keeps model swaps cheap |
| Reranker | **`BAAI/bge-reranker-v2-m3`** cross-encoder | Apache 2.0, ~568M, right size/quality point |
| Agent LLM | **Claude Sonnet** via Anthropic SDK | Citations API gives structured citation spans, not regex-parsed tags |
| Eval | **Ragas v0.2** + deterministic retrieval metrics + custom citation judge | Reference-free + reference-based mix; covers retrieval and answer quality |
| Dataset | **`yixuantt/MultiHopRAG`** (primary), FinanceBench (domain-swap) | Gold evidence_list per query, multi-hop, four query types incl. null |

---

## Architecture

```
rag/
├── core/
│   ├── models.py          # Document, Chunk, Citation, RetrievedChunk
│   ├── datasource.py      # DataSource Protocol
│   ├── chunker.py         # Chunker Protocol
│   ├── embedder.py        # Embedder Protocol
│   ├── vectorstore.py     # VectorStore Protocol
│   ├── reranker.py        # Reranker Protocol
│   └── retriever.py       # Retriever (composes vectorstore + reranker)
├── adapters/
│   ├── sources/{hf,files,web,sql}.py
│   ├── chunkers/{recursive,semantic,contextual}.py
│   ├── embedders/{bge,bm25}.py
│   ├── vectorstores/qdrant.py
│   └── rerankers/bge_cross.py
├── agent/
│   ├── prompts.py
│   ├── tools.py           # search_knowledge_base tool def
│   └── loop.py            # message + tool_use loop
├── eval/
│   ├── harness.py
│   ├── retrieval.py       # recall@k, MRR, NDCG
│   ├── ragas_runner.py
│   └── citation.py        # custom citation LLM-judge
└── apps/
    ├── multihop_rag.py    # wires MultiHopRAG through the stack
    └── financebench.py    # domain-swap proof (Slice 6)
```

The agent imports only `core/`. To swap datasets, add a new `DataSource` adapter — agent code is untouched.

### Core data model

```python
@dataclass(frozen=True)
class Document:
    doc_id: str
    text: str
    metadata: dict          # source, url, title, author, published_at, ...

@dataclass(frozen=True)
class Chunk:
    chunk_id: str           # stable: f"{doc_id}::{ordinal}"
    doc_id: str
    text: str
    ordinal: int
    metadata: dict

@dataclass(frozen=True)
class RetrievedChunk:
    chunk: Chunk
    score: float
    rank: int
    retriever: str          # "dense" | "sparse" | "rrf" | "rerank"
```

### Protocols

```python
class DataSource(Protocol):
    def iter_documents(self) -> Iterator[Document]: ...
    def get_eval_set(self) -> list[EvalExample]: ...

class Chunker(Protocol):
    def chunk(self, doc: Document) -> list[Chunk]: ...

class Embedder(Protocol):
    dim: int
    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...

class VectorStore(Protocol):
    def upsert(self, chunks: list[Chunk], dense, sparse) -> None: ...
    def hybrid_search(self, dense_q, sparse_q, k, filters) -> list[RetrievedChunk]: ...

class Reranker(Protocol):
    def rerank(self, query: str, candidates, top_n: int) -> list[RetrievedChunk]: ...
```

---

## Vertical slices (build order)

Each slice is **shippable on its own**. After Slice 1 you have a working demo. After every later slice you have a better one with a committed before/after eval delta.

Don't parallelize. Slice 1 forces the interfaces; Slice 2 forces the eval harness; after that you're swapping organs.

### Slice 1 — Walking skeleton

**Ship:** End-to-end pipeline that answers *one* hardcoded question against *ten* hardcoded docs, with citations, plus one retrieval metric and one answer metric printed.

- `Document`/`Chunk` dataclasses, `DataSource` Protocol — minimal `HFDatasetSource` that loads 10 MultiHopRAG docs from a JSON fixture
- `RecursiveCharacterChunker` at 512/64 only
- `BGEEmbedder` only
- `QdrantVectorStore` **dense only** — no sparse, no hybrid
- No reranker
- Agent loop: Anthropic SDK, `search_knowledge_base` tool, Citations API enabled on document blocks
- Eval shell that runs 1 example, prints `recall@5` + `faithfulness`

**Definition of done:** `python -m apps.multihop_rag "Which company acquired Activision?"` returns an answer with structured citations pointing to actual chunks, and a one-line eval prints two numbers.

### Slice 2 — Real corpus + retrieval metrics

**Ship:** Same agent, full 609-doc MultiHopRAG corpus, evaluated on 100 stratified queries with proper retrieval metrics.

- Full `HFDatasetSource` adapter (corpus + eval splits)
- Index the whole corpus into persistent Qdrant (`./qdrant_db`)
- Stratified eval set builder — balance across `inference_query`, `comparison_query`, `temporal_query`, `null_query`
- Retrieval metrics: `recall@{5,10,20}`, `MRR`, `NDCG@10`
- **Baseline numbers committed to `eval/results/slice2.md`.** This is your "before" snapshot.

**Definition of done:** A markdown eval table committed to the repo. The agent is mediocre (dense-only, no rerank) but measured.

### Slice 3 — Hybrid + rerank

**Ship:** Same eval, better numbers, one commit with a clear before/after diff.

- Add sparse vectors to the Qdrant collection (server-side BM25, `modifier=IDF`)
- `hybrid_search` via Query API with two `Prefetch` blocks + `FusionQuery(fusion=Fusion.RRF)`
- `BGECrossEncoderReranker`, top-50 → top-8
- Re-run the same eval set, commit numbers to `eval/results/slice3.md`
- Expected: recall@10 up 10-20 points, NDCG@10 similar

**Definition of done:** A diff commit titled "hybrid + rerank" with the before/after eval table in the PR description. This is the single highest-ROI slice — most of the "RAG actually works" magic happens here.

### Slice 4 — Agentic retrieval + answer evals

**Ship:** Multi-hop queries actually work, plus the answer-quality side of evals shows up.

- Query rewriter using Haiku — 3 variants + 1 HyDE-style hypothetical answer
- `MultiQueryRetriever` decorator — 4 hybrid searches, RRF merge, then rerank
- Tighten agent system prompt: instruct it to issue *narrower* follow-up retrievals on missing sub-facts
- Ragas v0.2: `context_precision`, `context_recall`, `faithfulness`, `answer_relevancy`, `factual_correctness`
- Custom citation accuracy LLM-judge: `citation_precision` (does the cited chunk support the claim?) + `citation_coverage` (does every load-bearing claim have a citation?)
- Re-run full eval, commit numbers to `eval/results/slice4.md`

**Definition of done:** Full eval scorecard with retrieval + answer + citation metrics, broken out by query type.

### Slice 5 — Failure analysis + one targeted fix

**Ship:** A before/after on one specific failure mode you found and chose.

- Open the bottom-10 lowest-scoring examples
- Categorize each: retrieval miss / reranker miss / LLM ignored context / citation mismatch
- Pick the dominant failure mode — likely candidates:
  - Anthropic-style **contextual retrieval** (Haiku prepends a 1-sentence context to each chunk before embedding + BM25)
  - Chunk size tuning (try 384/48 or 768/96)
  - Raise rerank candidates from 50 to 100
- Re-run eval, commit `eval/results/slice5.md` with the delta + a short "what I changed and why" writeup

**Definition of done:** A README section showing failure categorization, the chosen fix, and before/after numbers.

### Slice 6 — Domain swap

**Ship:** Proof that the architecture decouples from the dataset.

- Write a second `DataSource` adapter — FinanceBench (small, page-level citation gold) or RAGBench `techqa` subset
- Run the same pipeline over the new corpus with **zero changes to agent code**
- Run the same evals on the new domain
- Commit `eval/results/slice6.md`

**Definition of done:** Two `apps/` entry points working off the same `agent/` code. The "domain-agnostic" claim in the README is now tested, not aspirational.

---

## Slice exit criteria at a glance

| Slice | End-of-slice demo |
|---|---|
| 1 | 1 question, 10 docs, citations + 2 metrics |
| 2 | Full corpus, 100-Q eval, baseline numbers committed |
| 3 | Hybrid+rerank, recall@10 up 10-20pts vs baseline |
| 4 | Multi-hop working, full Ragas + citation scorecard |
| 5 | One fix shipped with before/after delta |
| 6 | Same agent code answering on a second dataset |

---

## Key learning moments to pay attention to

1. **Chunking is the ceiling.** Resist semantic chunking until eval demands it. Recursive 512/64 is the defensible default.
2. **Embedding choice matters, but less than chunking and reranking.** A 2-point MTEB gap is dwarfed by a 10-point reranker gain.
3. **Dense + BM25 + RRF is not optional.** Anthropic's contextual-retrieval numbers: dense alone → +35% improvement from contextual embeddings → +49% adding BM25 → +67% adding reranker. The composition matters.
4. **Reranking with a cross-encoder is the single highest-ROI step.** Don't skip it.
5. **Citation tracking is plumbing IDs.** `chunk_id` → Qdrant payload → `document.context` in the message → citation span → back to gold for eval. Any layer that drops the ID breaks citation eval.
6. **The agent loop is just `while tool_use: execute; append; resend`.** Cap turns to avoid runaway. Tell the model to search for *missing sub-facts*, not re-search with the same words.
7. **Retrieval metrics and answer metrics measure different failures.** Both can be high while answer correctness is low. Track all three.
8. **LLM-as-judge needs calibration.** Different judge model than the agent. Sanity-check against 5-10 human-graded examples. Report variance, not point estimates.

---

## Deliberately out of scope

- No UI (CLI + notebook is sufficient)
- No deployment / Docker / cloud — mention how you'd do it, don't build it
- No fine-tuning embeddings or rerankers
- No multi-tenancy, auth, rate-limiting
- No conversational memory across turns — each query is a fresh agent run

---

## Caveats

- Vector DB landscape shifts fast; pgvector wins when the team already runs Postgres. Qdrant teaches more vector-DB-specific concepts for portfolio purposes.
- Embedding leaderboards turn over monthly. The `Embedder` Protocol means a swap is one hour, not one day.
- LLM-as-judge has known position/verbosity/self-preference biases. Treat Ragas scores as regression detectors, not absolute truth.
- MultiHopRAG's `null_query` examples are small but important — naive RAG hallucinates on them. Stratify your eval set to keep them in.
- The Anthropic Citations API couples you to Claude. Fallback pattern for portability: prompt any model to emit `<cite chunk_id="...">...</cite>` tags. Make the swap local to one adapter.
