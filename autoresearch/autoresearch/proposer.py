"""Lets the Claude Code subscription do the proposing, instead of an API key.

GEPA normally reaches its model through litellm, which bills an API key. But
it will accept any callable of the shape `(prompt) -> text`, so we can hand it
the `claude` command line instead -- the same one the agent side already uses,
authenticated by your subscription.

The trade is real and worth stating. A subscription has rate limits rather
than a balance, and the agent being measured is spending the *same* quota. If
a run exhausts it, the questions start failing and those failures look like a
bad candidate rather than a throttled account. Prefer this for short runs; for
long ones, an API key keeps the two apart.
"""

from __future__ import annotations

import subprocess

from . import config

# Long, because a proposal is a whole rewritten file rather than a reply.
PROPOSE_TIMEOUT_S = 900


class ProposerFailed(Exception):
    """The proposing model returned nothing usable."""


def _flatten(prompt: str | list[dict]) -> str:
    """GEPA sends either a plain string or chat messages; `claude -p` takes text."""
    if isinstance(prompt, str):
        return prompt
    parts = []
    for message in prompt:
        content = message.get("content", "")
        if isinstance(content, list):  # content blocks
            content = "\n".join(
                block.get("text", "") for block in content if isinstance(block, dict)
            )
        role = message.get("role", "user")
        parts.append(content if role == "user" else f"[{role}]\n{content}")
    return "\n\n".join(p for p in parts if p)


def claude_cli(model: str = config.PROPOSER_MODEL):
    """A proposer GEPA can call, backed by the Claude Code subscription.

    Deliberately no tools and no skills: the proposer's job is to read the
    feedback and write a better file, not to go exploring. Giving it Bash here
    would let it touch the copy of the tool we are measuring.
    """

    def propose(prompt: str | list[dict]) -> str:
        result = subprocess.run(
            ["claude", "-p", _flatten(prompt), "--model", model],
            capture_output=True, text=True, timeout=PROPOSE_TIMEOUT_S,
        )
        if result.returncode != 0:
            raise ProposerFailed(
                f"`claude -p` exited {result.returncode}: {result.stderr.strip()[:500]}"
            )
        text = result.stdout.strip()
        if not text:
            raise ProposerFailed("`claude -p` returned nothing")
        return text

    return propose
