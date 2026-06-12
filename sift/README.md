# sift

An internal knowledge-base research agent: ask a natural-language question and get
a **cited, source-grounded answer** where every claim links back to the passage it
came from.

## What it does

Indexes the 609-document [MultiHopRAG](https://huggingface.co/datasets/yixuantt/MultiHopRAG)
corpus, then answers questions with an Anthropic agent that retrieves, synthesises
across sources, cites every claim via the **Citations API**, and honestly says "I
don't know" when the corpus can't answer. Each retrieval organ is swappable behind
a `core/` Protocol; the agent imports only `core/`.

```bash
python -m apps.index                                        # build the index once
python -m apps.multihop_rag --stage rerank "Which company acquired Activision?"
```

## Run it

Requires `ANTHROPIC_API_KEY`. Use Python 3.12 or 3.13; the project metadata is
bounded to `>=3.12,<3.14` because dependency wheels are not consistently available
on newer interpreters.

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv -e .
uv pip install --python .venv datasets sentence-transformers \
  "ragas==0.2.*" "langchain-anthropic>=0.3,<0.4" "langchain-community>=0.3,<0.4"
```

With Poetry, create/use a compatible interpreter before installing:

```bash
poetry env use python3.12
poetry install
```

### Qdrant

Qdrant runs **embedded** — no separate server or daemon to start. The
`qdrant-client` package is pulled in by the install step above, and the index is
persisted on disk to `./qdrant_db` (tests use an in-memory `:memory:` store). If
the dependency is missing, install it directly:

```bash
.venv/bin/pip install "qdrant-client>=1.12"   # or: poetry add "qdrant-client>=1.12"
```

To run a standalone Qdrant server instead (optional), start one with Docker:

```bash
docker run -p 6333:6333 -v "$(pwd)/qdrant_db:/qdrant/storage" qdrant/qdrant
```

Then run the app with the selected environment. If using Poetry, replace
`.venv/bin/python` with `poetry run python`.

```bash
# 1. index the corpus (idempotent; --stage hybrid adds sparse BM25 vectors)
.venv/bin/python -m apps.index --stage hybrid

# 2. answer a question (stages: dense | hybrid | rerank | multiquery)
.venv/bin/python -m apps.multihop_rag --stage rerank "Which company acquired Activision?"

# 3. retrieval eval (writes eval/results/sliceN.{json,md} with a delta vs the prev slice)
.venv/bin/python -m eval.run_retrieval --slice 4 --stage rerank --prev-slice 3

# 4. answer-quality eval (agent + Ragas + citation judge, by query type, with CIs)
.venv/bin/python -m eval.run_answer --slice 6 --stage multiquery --per-type 6

# 5. calibrate the citation judge against human grades
.venv/bin/python -m eval.calibrate
```

**Embedder:** open `BAAI/bge-small-en-v1.5` via fastembed, running locally.
All committed numbers are BGE-small. **Reranker:** `bge-reranker-v2-m3`
(auto-selects Apple MPS). **Judges:** agent = Opus, Ragas = Sonnet, citation = Sonnet,
faithfulness = Haiku — every judge differs from the agent (PLAN.md learning #8).

Offline tests:

```bash
.venv/bin/python -m pytest tests/ -q
```
