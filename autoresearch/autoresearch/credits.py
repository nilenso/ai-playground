"""Asks OpenRouter whether we can actually afford this run.

A run measures the unchanged tool first, which takes about an hour and costs
real money, and only *then* makes its first call to the model that proposes
changes. So a credentials problem surfaces at the worst possible moment: after
you have paid for the baseline and just as the useful work begins.

Checking presence of a key is not enough. Two failures both look like a key
that is set:

- the key was revoked, so every call returns 401;
- the key is fine but the account is out of credit.

Both are answered by one cheap request, so we make it before anything starts.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

CREDITS_URL = "https://openrouter.ai/api/v1/credits"


class Unauthorized(Exception):
    """The key was rejected. Nothing will work until it is replaced."""


class Unreachable(Exception):
    """We could not ask. Says nothing about the key."""


@dataclass(frozen=True)
class Balance:
    granted: float
    used: float

    @property
    def remaining(self) -> float:
        return self.granted - self.used


def fetch(api_key: str, timeout: float = 15.0) -> Balance:
    """Ask OpenRouter what is left. Costs nothing and spends no tokens."""
    request = urllib.request.Request(
        CREDITS_URL, headers={"Authorization": f"Bearer {api_key}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise Unauthorized(
                "OpenRouter rejected the key. It has been revoked, or belongs "
                "to an account that no longer exists. Replace it in .env."
            ) from exc
        raise Unreachable(f"OpenRouter returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise Unreachable(str(exc)) from exc

    data = payload.get("data", {})
    return Balance(granted=float(data.get("total_credits", 0.0)),
                   used=float(data.get("total_usage", 0.0)))


def assess(balance: Balance, minimum: float) -> str:
    """Turn a balance into a line worth printing, or refuse the run.

    Pure, so the interesting half is testable without a network.
    """
    if balance.remaining < minimum:
        raise ValueError(
            f"OpenRouter has ${balance.remaining:.2f} left, which is below the "
            f"${minimum:.2f} floor. The baseline would run for about an hour "
            f"and then the first proposal would fail. Top up first."
        )
    return f"OpenRouter balance ${balance.remaining:.2f}"
