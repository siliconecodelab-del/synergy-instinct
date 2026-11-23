"""
DsPy evaluation harness for Open Instinct agent behavior.

Tests agent tool selection and permission boundaries by sending messages
to the agent's HTTP API and checking which tools were actually invoked,
as recorded in the per-turn traces (GET /agentrun/traces).

Usage:
    python eval_agent.py --url http://127.0.0.1:8099 --cases golden_cases.json
    python eval_agent.py --url http://127.0.0.1:8099 --cases golden_cases.json --output results.json

Requirements:
    pip install dspy-ai requests
"""
import argparse
import json
import time
import requests

# Tools the agent may invoke; matched against trace tool_call entries.
API_TOOLS = [
    "generate_dynamic_sop",
    "sop_visualize_role_map",
    "sop_proactive_nudge",
    "sop_check_required_tools",
    "notify_owner",
]


def send_message(url: str, message: str, chat_token: str | None = None, timeout: int = 60) -> dict:
    """Send a message to the agent and return the response."""
    headers = {"Content-Type": "application/json"}
    if chat_token:
        headers["x-instinct-token"] = chat_token
    resp = requests.post(
        f"{url}/chat",
        json={"message": message},
        headers=headers,
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_traces(url: str, chat_token: str | None = None, timeout: int = 30) -> list:
    """Fetch per-turn traces from the agent's /agentrun/traces endpoint.

    Requires INSTINCT_AGENTRUN=1 on the agent. Returns the raw trace list
    (newest first) or [] if the endpoint is unavailable.
    """
    headers = {}
    if chat_token:
        headers["x-instinct-token"] = chat_token
    try:
        resp = requests.get(
            f"{url.rstrip('/')}/agentrun/traces",
            headers=headers,
            timeout=timeout,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    traces = data.get("traces")
    return traces if isinstance(traces, list) else []


def tools_from_traces(traces: list, conversation_key: str, input_text: str) -> list:
    """Return the names of tools invoked in the trace matching this turn.

    Traces are newest-first, so the first trace whose input conversation key
    and text match this turn is the one we just produced. Falls back to []
    when no matching trace is found (e.g. AgentRun traces not enabled).
    """
    for trace in traces:
        if not isinstance(trace, dict):
            continue
        inp = trace.get("input") or {}
        if inp.get("conversationKey") != conversation_key:
            continue
        if inp.get("text") != input_text:
            continue
        calls = trace.get("toolCalls") or []
        return [c.get("tool") for c in calls if isinstance(c, dict) and c.get("tool")]
    return []


def evaluate_case(url: str, case: dict, chat_token: str | None = None) -> dict:
    """Evaluate a single golden case."""
    result = {
        "id": case["id"],
        "category": case["category"],
        "input": case["input"],
        "passed": False,
        "actual_tools": [],
        "expected_tools": [],
        "error": None,
    }

    try:
        resp = send_message(url, case["input"], chat_token=chat_token)
        conversation_key = resp.get("conversationKey", "")
        response_text = resp.get("response", "")

        # The assistant's natural-language reply is not a reliable signal of
        # which tools ran; the per-turn traces record every tool_call by name.
        traces = fetch_traces(url, chat_token=chat_token)
        actual_tools = [t for t in tools_from_traces(traces, conversation_key, case["input"])
                        if t in API_TOOLS]

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


def run_evaluation(url: str, cases_path: str, chat_token: str | None = None) -> dict:
    """Run the full evaluation suite."""
    with open(cases_path) as f:
        cases = json.load(f)

    results = []
    passed = 0
    failed = 0

    for case in cases:
        print(f"  Evaluating: {case['id']}...", end=" ", flush=True)
        result = evaluate_case(url, case, chat_token=chat_token)
        results.append(result)
        if result["passed"]:
            passed += 1
            print("PASS")
        else:
            failed += 1
            print(f"FAIL (expected: {result['expected_tools']}, got: {result['actual_tools']})")
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
    args = parser.parse_args()

    print(f"Evaluating agent at {args.url}")
    print(f"Cases: {args.cases}")
    print()

    report = run_evaluation(args.url, args.cases, chat_token=args.chat_token)

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
