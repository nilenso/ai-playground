import inspect


def test_optimizer_sabotage_gate_passes_before_paid_runs():
    from autoresearch.optimize import run_sabotage_gate

    run_sabotage_gate()


def test_optimizer_runs_sabotage_gate_before_preflight_or_gepa():
    from autoresearch import optimize

    src = inspect.getsource(optimize.run)

    assert src.index("run_sabotage_gate()") < src.index("config.preflight")
    assert src.index("run_sabotage_gate()") < src.index("oa.optimize_anything")
