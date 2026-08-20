"""Puts a name to why a command failed.

Always returns a label, never None, so nothing downstream has to handle a
missing answer. "clean" means we found nothing wrong.

The order matters: we check the most specific patterns first, because a
traceback also contains the word "error".
"""

from __future__ import annotations

from .trace import Call

_TRACEBACK = "Traceback (most recent call last)"

# The tell-tales of a call that failed on the way to the data, rather than a
# command that was wrong. Matched *before* the traceback check, because these
# arrive as tracebacks: botmap does not catch S3 errors, so pyarrow's OSError
# propagates raw and is otherwise indistinguishable from a genuine tool bug.
#
# Deliberately specific strings. A generic "timed out" would also match a tool
# error that merely mentions a --timeout flag, and mislabelling a real bug as
# weather would hide exactly what we are trying to find.
_NETWORK = (
    "curlcode",                        # curl's own numbering, e.g. curlCode: 28
    "aws error network_connection",
    "timeout was reached",             # curl's wording for code 28
    "connection reset by peer",
    "could not connect to",
    "failed to connect",
    "temporary failure in name resolution",
    "connection timed out",
)

LABELS = (
    "clean",
    "network_failure",
    "bad_category_value",
    "traceback",
    "unknown_command",
    "bad_option",
    "malformed_bbox_or_coords",
    "wrong_type_for_question",
    "other_error",
)


def classify(call: Call) -> str:
    err = call.stderr or ""
    low = err.lower()

    if call.exit_code == 0:
        # Exit 0 usually means fine. Two exceptions: the tool sometimes
        # succeeds while telling you your filter value was wrong, which is the
        # worst failure we have — it looks exactly like "there are none here".
        if "did you mean:" in low:
            return "bad_category_value"
        if "0 rows" in low and "categories.primary" in low:
            return "bad_category_value"
        # The "I picked one of several matching places" note is information,
        # not a failure, so it deliberately doesn't count.
        return "clean"

    # Before the traceback check: these *are* tracebacks, and calling them
    # tool bugs would blame the tool for our connection.
    if any(marker in low for marker in _NETWORK):
        return "network_failure"
    if _TRACEBACK in err:
        return "traceback"
    if "no such command" in low:
        return "unknown_command"
    if "no such option" in low:
        return "bad_option"
    if "latlon" in low or "lat,lon" in low or "must be numeric" in low:
        return "malformed_bbox_or_coords"
    if "bbox" in low and any(w in low for w in ("invalid", "must", "expected")):
        return "malformed_bbox_or_coords"
    if "no features available for type" in low:
        return "wrong_type_for_question"
    if "usage:" in low and "error:" in low:
        return "bad_option"
    return "other_error"
