#!/usr/bin/env python3
"""
Dataset curation: extract golden evaluation cases from agent telemetry.

Reads telemetry JSONL files from the agent's state directory and converts
successful tool-calling conversations into golden test cases for DsPy evaluation.

Usage:
    python curate_dataset.py --state-dir /path/to/agent/data --output golden_cases.json
    python curate_dataset.py --state-dir /path/to/agent/data --output golden_cases.json --min-success-rate 0.9
"""
import argparse
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta


def read_telemetry(state_dir: str, since_days: int = 7) -> list:
    """Read telemetry entries from the last N days."""
    telemetry_dir = os.path.join(state_dir, "eval", "telemetry")
    if not os.path.exists(telemetry_dir):
        return []

    cutoff = (datetime.utcnow() - timedelta(days=since_days)).isoformat()
    entries = []

    for filename in sorted(os.listdir(telemetry_dir)):
        if not filename.endswith(".jsonl"):
            continue
        filepath = os.path.join(telemetry_dir, filename)
        with open(filepath) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    if entry.get("timestamp", "") >= cutoff:
                        entries.append(entry)
                except json.JSONDecodeError:
                    continue

    return entries


def extract_tool_calls(entries: list) -> list:
    """Extract successful tool-calling conversations from telemetry entries."""
    # Group by conversation
    conversations = defaultdict(list)
    for entry in entries:
        conversations[entry.get("conversationKey", "unknown")].append(entry)

    tool_calls = []
    for conv_key, conv_entries in conversations.items():
        for entry in conv_entries:
            if entry.get("tool") and entry.get("outcome") == "allow":
                tool_calls.append({
                    "conversation_key": conv_key,
                    "principal": entry.get("principal", "unknown"),
                    "tier": entry.get("tier", "unknown"),
                    "tool": entry.get("tool"),
                    "input": entry.get("input", {}),
                    "timestamp": entry.get("timestamp"),
                    "duration_ms": entry.get("durationMs"),
                })

    return tool_calls


def curate_golden_cases(tool_calls: list, min_success_rate: float = 0.9) -> list:
    """Convert successful tool calls into golden evaluation cases."""
    # Group by tool name
    by_tool = defaultdict(list)
    for tc in tool_calls:
        by_tool[tc["tool"]].append(tc)

    cases = []
    case_id = 1

    for tool_name, calls in by_tool.items():
        # Take the most common input patterns
        input_patterns = defaultdict(int)
        for call in calls:
            # Create a simplified input key
            input_key = json.dumps(call["input"], sort_keys=True) if call["input"] else "{}"
            input_patterns[input_key] += 1

        # Sort by frequency
        sorted_patterns = sorted(input_patterns.items(), key=lambda x: -x[1])

        # Take top patterns as golden cases (deduplicate by input)
        seen_inputs = set()
        for pattern, count in sorted_patterns[:5]:  # Max 5 per tool
            try:
                input_obj = json.loads(pattern)
            except json.JSONDecodeError:
                continue

            # Skip if we've seen this input pattern
            input_hash = hash(pattern)
            if input_hash in seen_inputs:
                continue
            seen_inputs.add(input_hash)

            # Determine category
            category = "tool_selection"
            if "stranger" in str(calls[0].get("tier", "")):
                category = "permission_boundary"

            # Create a human-readable input message
            # This is a simplification — in practice, you'd want the original user message
            input_msg = f"Use {tool_name} with {json.dumps(input_obj)}"

            cases.append({
                "id": f"curated-{case_id}",
                "input": input_msg,
                "expected_tool": tool_name,
                "expected_params_contain": input_obj if input_obj else {},
                "category": category,
                "source": "telemetry",
                "frequency": count,
                "tier": calls[0].get("tier", "unknown"),
            })
            case_id += 1

    return cases


def merge_with_existing(new_cases: list, existing_path: str) -> list:
    """Merge new cases with existing golden cases, avoiding duplicates."""
    if not os.path.exists(existing_path):
        return new_cases

    with open(existing_path) as f:
        existing = json.load(f)

    existing_ids = {c["id"] for c in existing}
    merged = list(existing)

    for case in new_cases:
        if case["id"] not in existing_ids:
            merged.append(case)

    return merged


def main():
    parser = argparse.ArgumentParser(description="Curate golden evaluation cases from telemetry")
    parser.add_argument("--state-dir", required=True, help="Agent state directory")
    parser.add_argument("--output", default="golden_cases.json", help="Output golden cases JSON")
    parser.add_argument("--existing", default=None, help="Existing golden cases to merge with")
    parser.add_argument("--since-days", type=int, default=7, help="Days of telemetry to include")
    parser.add_argument("--min-success-rate", type=float, default=0.9, help="Minimum success rate for inclusion")
    args = parser.parse_args()

    print(f"Reading telemetry from {args.state_dir} (last {args.since_days} days)...")
    entries = read_telemetry(args.state_dir, args.since_days)
    print(f"  Found {len(entries)} telemetry entries")

    tool_calls = extract_tool_calls(entries)
    print(f"  Extracted {len(tool_calls)} successful tool calls")

    new_cases = curate_golden_cases(tool_calls, args.min_success_rate)
    print(f"  Curated {len(new_cases)} new golden cases")

    existing_path = args.existing or args.output
    merged = merge_with_existing(new_cases, existing_path)
    print(f"  Total cases after merge: {len(merged)}")

    with open(args.output, "w") as f:
        json.dump(merged, f, indent=2)
    print(f"  Written to {args.output}")


if __name__ == "__main__":
    main()
PYEOF
echo "Created curate_dataset.py"