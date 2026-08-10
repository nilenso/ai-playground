from pathlib import Path

from harbor.models.dataset.manifest import DatasetManifest
from harbor.models.task.config import TaskConfig
from harbor.models.trajectories.trajectory import Trajectory

ROOT = Path(__file__).parent
REPO_ROOT = ROOT.parent

DatasetManifest.from_toml_file(ROOT / "dataset.toml")
print(f"valid dataset: {ROOT / 'dataset.toml'}")

tasks = sorted((ROOT / "tasks").glob("*/task.toml"))
trajectories = sorted((REPO_ROOT / "sft").glob("*.json"))

if not tasks:
    raise SystemExit("No Harbor tasks found")
if not trajectories:
    raise SystemExit("No ATIF trajectories found")

for task_config in tasks:
    TaskConfig.model_validate_toml(task_config.read_text())
    required = ["instruction.md", "environment/Dockerfile", "tests/test.sh"]
    for relative_path in required:
        if not (task_config.parent / relative_path).exists():
            raise SystemExit(f"Missing {relative_path} in {task_config.parent}")
    print(f"valid task: {task_config.parent}")

for trajectory_path in trajectories:
    Trajectory.model_validate_json(trajectory_path.read_text())
    print(f"valid trajectory: {trajectory_path}")
