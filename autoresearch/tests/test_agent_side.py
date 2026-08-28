from autoresearch.agenteval.agent_side import detect_ignored_hints


def test_detects_strict_ignored_hint_and_records_later_use():
    calls = [
        {
            "argv": ["count", "-t", "place", "--where", "categories.primary=bus_stop"],
            "stderr_head": "Bad category. Did you mean: bus_station",
        },
        {"argv": ["categories", "-t", "place", "--top", "300"]},
        {"argv": ["count", "-t", "place", "--where", "categories.primary=bus_station"]},
    ]

    findings = detect_ignored_hints(calls, window=2)

    assert len(findings) == 1
    assert findings[0]["kind"] == "ignored_hint"
    assert findings[0]["at_call"] == 0
    assert findings[0]["ignored_by_next"] is True
    assert findings[0]["suggestions"] == ["bus_station"]
    assert findings[0]["eventually_used"] is True
    assert findings[0]["used_at_call"] == 2
    assert findings[0]["window_argv"] == [
        ["categories", "-t", "place", "--top", "300"],
        ["count", "-t", "place", "--where", "categories.primary=bus_station"],
    ]


def test_does_not_flag_when_next_call_uses_hint():
    calls = [
        {"argv": ["count", "--where", "categories.primary=bus_stop"], "stderr": "Did you mean: `bus_station`"},
        {"argv": ["count", "--where", "categories.primary=bus_station"]},
    ]

    assert detect_ignored_hints(calls) == []
