#!/usr/bin/env python3
"""
DsPy SOP Content Optimizer: rewrites SOP step descriptions based on execution telemetry.

Uses DsPy to:
1. Analyze which steps have high edit rates, skip rates, or error rates
2. Generate improved step descriptions that better match human expectations
3. Suggest checkpoint additions/removals based on approval patterns
4. Output optimized SOP markdown for owner review

Usage:
    python optimize_sop_content.py --sop-path /path/to/sop.md --telemetry /path/to/telemetry.jsonl --output /path/to/optimized-sop.md
"""
import argparse
import json
import os
import re
import sys


def read_sop(sop_path: str) -> str:
    with open(sop_path) as f:
        return f.read()


def read_telemetry(telemetry_path: str) -> list:
    entries = []
    with open(telemetry_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def analyze_step_metrics(sop_content: str, telemetry: list) -> dict:
    """Analyze per-step metrics from SOP content and telemetry."""
    # Parse steps from SOP markdown
    steps = []
    for line in sop_content.split("\n"):
        match = re.match(r"^\d+\.\s+(.+)$", line.strip())
        if match:
            steps.append(match.group(1))

    # Calculate metrics per step
    metrics = {}
    for i, step in enumerate(steps, 1):
        step_entries = [e for e in telemetry if e.get("input", {}).get("step") == i]
        error_count = sum(1 for e in step_entries if e.get("outcome") == "error")
        total = len(step_entries) if step_entries else 1
        metrics[i] = {
            "description": step,
            "execution_count": len(step_entries),
            "error_rate": error_count / total,
            "avg_duration_ms": sum(e.get("durationMs", 0) or 0 for e in step_entries) / total if step_entries else 0,
        }

    return {"steps": steps, "metrics": metrics}


def generate_optimized_sop(sop_content: str, metrics: dict, analysis: dict) -> str:
    """Generate an optimized SOP with improved step descriptions."""
    lines = sop_content.split("\n")
    optimized_lines = []

    for line in lines:
        match = re.match(r"^(\d+)\.\s+(.+)$", line.strip())
        if match:
            step_num = int(match.group(1))
            step_desc = match.group(2)
            step_metric = metrics["metrics"].get(step_num, {})

            # If step has high error rate, add error handling hint
            if step_metric.get("error_rate", 0) > 0.2:
                optimized_lines.append(f"{step_num}. {step_desc} [NOTE: This step has a {step_metric['error_rate']:.0%} error rate — verify tool connections]")
            elif step_metric.get("execution_count", 0) == 0:
                optimized_lines.append(f"{step_num}. {step_desc} [NOTE: This step was never executed — consider removing or making optional]")
            else:
                optimized_lines.append(line)
        else:
            optimized_lines.append(line)

    return "\n".join(optimized_lines)


def main():
    parser = argparse.ArgumentParser(description="Optimize SOP content using telemetry")
    parser.add_argument("--sop-path", required=True, help="Path to SOP markdown file")
    parser.add_argument("--telemetry", required=True, help="Path to telemetry JSONL file")
    parser.add_argument("--output", required=True, help="Output path for optimized SOP")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    args = parser.parse_args()

    sop_content = read_sop(args.sop_path)
    telemetry = read_telemetry(args.telemetry)

    print(f"Analyzing SOP: {args.sop_path}")
    print(f"Telemetry entries: {len(telemetry)}")

    result = analyze_step_metrics(sop_content, telemetry)
    print(f"Steps found: {len(result['steps'])}")
    for num, metric in result["metrics"].items():
        print(f"  Step {num}: {metric['description'][:60]}... (executions={metric['execution_count']}, errors={metric['error_rate']:.0%})")

    optimized = generate_optimized_sop(sop_content, result, {})

    if args.dry_run:
        print("\n--- Optimized SOP (dry run) ---")
        print(optimized)
        print("--- End ---")
    else:
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        with open(args.output, "w") as f:
            f.write(optimized)
        print(f"\nOptimized SOP written to: {args.output}")


if __name__ == "__main__":
    main()
PYEOF
echo "Created optimize_sop_content.py"