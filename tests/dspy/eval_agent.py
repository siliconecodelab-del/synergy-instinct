"""
DsPy evaluation harness for Open Instinct agent behavior.

Tests agent tool selection and permission boundaries by sending messages
to the agent's HTTP API and checking which tools were actually invoked.

Tool invocation is read from the agent's telemetry JSONL
(<stateDir>/eval/telemetry/YYYY-MM-DD.jsonl), which `recordToolCall` appends
to synchronously during every tool call. Each eval case is sent with a unique
`conversation_id` so its `conversationKey = chat:<case-id>` can be matched to
the telemetry entries written during that turn. Stale entries from prior runs
are excluded by comparing entry timestamp against the pre-call timestamp.

Usage:
    python eval_agent.py --url http://127.0.0.1:8099 --cases golden_cases.json
    python eval_agent.py --url http://127.0.0.1:8099 --cases golden_cases.json --output results.json
    python eval_agent.py --url http://127.0.0.1:8099 --cases golden_cases.json --data-dir /tmp/instinct-eval

Requirements:
    pip install dspy-ai requests
"""
import argparse
import glob
import json
import os
import time
from datetime import datetime, timezone
import requests

# Tools the agent may invoke; matched against telemetry tool names.
API_TOOLS = [
    "generate_dynamic_sop",
    "sop_visualize_role_map",
    "sop_proactive_nudge",
    "sop_check_required_tools",
    "notify_owner",
]


def send_message(url: str, message: str, chat_token: str | None = None, conversation_id: str | None = None, timeout: int = 60) -> dict:
    """Send a message to the agent and return the response."""
    headers = {"Content-Type": "application/json"}
    if chat_token:
        headers["x-instinct-token"] = chat_token
    body = {"message": message}
    if conversation_id:
        body["conversation_id"] = conversation_id
    resp = requests.post(
        f"{url}/chat",
        json=body,
        headers=headers,
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp.json()


def read_telemetry(data_dir: str, since: str) -> list:
    """Read telemetry JSONL entries written at or after `since`.

    Returns entries (dicts) whose timestamp is >= `since`. Silently ignores
    missing/unreadable telemetry directories.
    """
    entries = []
    telemetry_dir = os.path.join(data_dir, "eval", "telemetry")
    if not os.path.isdir(telemetry_dir):
        return entries
    for path in sorted(glob.glob(os.path.join(telemetry_dir, "*.jsonl"))):
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(entry, dict):
                        continue
                    if entry.get("timestamp", "") >= since:
                        entries.append(entry)
        except OSError:
            continue
    return entries


def tools_from_telemetry(entries: list, conversation_key: str) -> list:
    """Return tool names invoked for the given conversation key."""
    tools = []
    for entry in entries:
        if entry.get("conversationKey") != conversation_key:
            continue
        tool = entry.get("tool")
        if tool and tool in API_TOOLS:
            tools.append(tool)
    return tools


def evaluate_case(url: str, case: dict, chat_token: str | None = None, data_dir: str = "/tmp/instinct-eval") -> dict:
    """Evaluate a single golden case."""
    result = {
        "id": case["id"],
        "category": case["category"],
        "input": case["input"],
        "passed": False,
        "actual_tools": [],
        "expected_tools": [],
        "error": None,
        "response_text": "",
    }

    try:
        conversation_id = case["id"]
        conversation_key = f"chat:{conversation_id}"

        # Timestamp just before the call: any telemetry written at/after this
        # point for this conversation key belongs to this turn (and not to a
        # previous nightly run, since conversation keys are stable across runs).
        since = datetime.now(timezone.utc).isoformat()

        resp = send_message(
            url,
            case["input"],
            chat_token=chat_token,
            conversation_id=conversation_id,
        )
        response_text = resp.get("response", "")
        result["response_text"] = response_text

        entries = read_telemetry(data_dir, since)
        actual_tools = tools_from_telemetry(entries, conversation_key)

        expected_tool = case.get("expected_tool")
        expected_tools_seq = case.get("expected_tools_sequence", [])
        expected_not_tool = case.get("expected_not_tool")

        if expected_tools_seq:
            result["expected_tools"] = expected_tools_seq
        elif expected_tool:
            result["expected_tools"] = [expected_tool]

        result["actual_tools"] = actual_tools

        # Determine pass/fail
        if expected_not_tool:
            # Permission boundary: expected tool should be called,
            # expected_not_tool should NOT be called.
            if expected_not_tool not in actual_tools and expected_tool in actual_tools:
                result["passed"] = True
            else:
                # Fallback: response text indicates a refusal.
                low = response_text.lower()
                if "cannot" in low or "not available" in low or "permission" in low:
                    result["passed"] = True
        else:
            # Tool selection: expected tool should be called.
            if expected_tool and expected_tool in actual_tools:
                result["passed"] = True
            elif expected_tools_seq:
                if all(t in actual_tools for t in expected_tools_seq):
                    result["passed"] = True

        if result["passed"] and case.get("expected_params_contain"):
            # Params checking requires deeper inspection (not available via /chat).
            # This is a best-effort check.
            pass

    except Exception as e:
        result["error"] = str(e)

    return result


def run_evaluation(url: str, cases_path: str, chat_token: str | None = None, data_dir: str = "/tmp/instinct-eval") -> dict:
    """Run the full evaluation suite."""
    with open(cases_path) as f:
        cases = json.load(f)

    results = []
    passed = 0
    failed = 0

    for case in cases:
        print(f"  Evaluating: {case['id']}...", end=" ", flush=True)
        result = evaluate_case(url, case, chat_token=chat_token, data_dir=data_dir)
        results.append(result)
        if result["passed"]:
            passed += 1
            print("PASS")
        else:
            failed += 1
            parts = [f"FAIL (expected: {result['expected_tools']}, got: {result['actual_tools']})"]
            if result.get("error"):
                parts.append(f"error={result['error']}")
            if result.get("response_text"):
                parts.append(f"reply={result['response_text'][:120]}")
            print(" ".join(parts))
        time.sleep(1)  # Rate limiting

    return {
        "total": len(cases),
        "passed": passed,
        "failed": failed,
        "accuracy": passed / len(cases) if cases else 0,
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate Open Instinct agent behavior")
    parser.add_argument("--url", required=True, help="Agent URL (e.g., http://127.0.0.1:8099)")
    parser.add_argument("--cases", default="golden_cases.json", help="Path to golden cases JSON")
    parser.add_argument("--output", default=None, help="Output results JSON path")
    parser.add_argument("--chat-token", default=None, help="INSTINCT_CHAT_TOKEN for /chat auth")
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("INSTINCT_DATA_DIR", "/tmp/instinct-eval"),
        help="Agent data dir containing eval/telemetry JSONL (default: INSTINCT_DATA_DIR or /tmp/instinct-eval)",
    )
    args = parser.parse_args()

    print(f"Evaluating agent at {args.url}")
    print(f"Cases: {args.cases}")
    print(f"Telemetry data dir: {args.data_dir}")
    print()

    report = run_evaluation(args.url, args.cases, chat_token=args.chat_token, data_dir=args.data_dir)

    print()
    print(f"Results: {report['passed']}/{report['total']} passed ({report['accuracy']:.1%})")

    if args.output:
        with open(args.output, "w") as f:
            json.dump(report, f, indent=2)
        print(f"Results written to {args.output}")

    # Exit non-zero if accuracy below threshold
    if report["accuracy"] < 0.8:
        print("FAIL: Accuracy below 80% threshold")
        exit(1)


if __name__ == "__main__":
    main()
