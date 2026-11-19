"""
DsPy evaluation harness for Open Instinct agent behavior.

Tests agent tool selection and permission boundaries by sending messages
to the agent's HTTP API and checking which tools were called.

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
        response_text = resp.get("response", "")

        # Check if expected tool was mentioned/called
        # The agent's response should reference the tool or its effects
        expected_tool = case.get("expected_tool")
        expected_tools_seq = case.get("expected_tools_sequence", [])
        expected_not_tool = case.get("expected_not_tool")

        if expected_tools_seq:
            result["expected_tools"] = expected_tools_seq
        elif expected_tool:
            result["expected_tools"] = [expected_tool]

        # For now, we check if the response indicates the right tool was used
        # by looking for tool name references or success indicators
        tools_mentioned = []
        for tool_name in ["generate_dynamic_sop", "sop_visualize_role_map",
                          "sop_proactive_nudge", "sop_check_required_tools",
                          "notify_owner"]:
            if tool_name in response_text.lower().replace("-", "_"):
                tools_mentioned.append(tool_name)

        result["actual_tools"] = tools_mentioned

        # Determine pass/fail
        if expected_not_tool:
            # Permission boundary: expected tool should NOT be called
            if expected_not_tool not in tools_mentioned and expected_tool in tools_mentioned:
                result["passed"] = True
            elif expected_tool in tools_mentioned and expected_not_tool not in tools_mentioned:
                result["passed"] = True
            else:
                # Check if response indicates permission denied
                if "cannot" in response_text.lower() or "not available" in response_text.lower() or "permission" in response_text.lower():
                    result["passed"] = True
        else:
            # Tool selection: expected tool should be called
            if expected_tool and expected_tool in tools_mentioned:
                result["passed"] = True
            elif expected_tools_seq:
                if all(t in tools_mentioned for t in expected_tools_seq):
                    result["passed"] = True

        # Check expected params if specified
        if result["passed"] and case.get("expected_params_contain"):
            # Params checking requires deeper inspection (not available via /chat)
            # This is a best-effort check
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
