# Open Instinct Evaluation Infrastructure

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Evaluation Loop                               │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Telemetry   │───▶│  Dataset     │───▶│  DsPy        │      │
│  │  Export      │    │  Curation    │    │  Optimization│      │
│  │  (JSONL)     │    │  (golden     │    │  (prompt     │      │
│  │              │    │   cases)     │    │   tuning)    │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
│                                                  │              │
│                                                  ▼              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Monitor     │◀───│  Deploy      │◀───│  Human       │      │
│  │  (regression │    │  (skills/    │    │  Review      │      │
│  │   detection) │    │   prompts)   │    │  (approve)   │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
eval/
├── README.md                    # This file
├── telemetry/
│   └── (JSONL files are in agent state dir: <state>/eval/telemetry/)
├── dataset/
│   └── curate_dataset.py        # Extract golden cases from telemetry
├── optimization/
│   └── optimize_prompts.py      # DsPy optimization pipeline
└── deploy/
    └── deploy_optimized.py      # Deploy optimized skills with rollback
```

## Components

### 1. Telemetry Export (`packages/core/src/telemetry-export.ts`)

Automatically exports tool execution data to JSONL files:
- **Location**: `<stateDir>/eval/telemetry/YYYY-MM-DD.jsonl`
- **Format**: One JSON object per line with timestamp, principal, tier, tool, outcome, input, response preview, error
- **Integration**: Hooked into `runtime.ts` `recordToolCall()` — every tool call is logged
- **Best-effort**: Never blocks tool execution; failures are silently ignored

### 2. Dataset Curation (`eval/dataset/curate_dataset.py`)

Extracts golden evaluation cases from telemetry:
- Groups successful tool calls by tool name
- Deduplicates by input pattern
- Merges with existing golden cases (no overwrites)
- Outputs `golden_cases.json`

```bash
python eval/dataset/curate_dataset.py --state-dir /tmp/instinct-local --output tests/dspy/golden_cases.json
```

### 3. DsPy Optimization (`eval/optimization/optimize_prompts.py`)

Runs DsPy-style optimization:
- Evaluates current agent against golden cases
- Analyzes failure patterns
- Generates few-shot examples from successful cases
- Suggests prompt improvements
- Writes optimized skill files

```bash
python eval/optimization/optimize_prompts.py --url http://127.0.0.1:8099 --cases tests/dspy/golden_cases.json --output eval/optimized/
```

### 4. Deployment (`eval/deploy/deploy_optimized.py`)

Applies optimized skills with safety:
- Dry-run mode for preview
- Automatic backup before overwrite
- Rollback to previous version
- Version tracking via timestamps

```bash
# Preview
python eval/deploy/deploy_optimized.py --skills-dir skills --optimized-dir eval/optimized --dry-run

# Apply
python eval/deploy/deploy_optimized.py --skills-dir skills --optimized-dir eval/optimized

# Rollback
python eval/deploy/deploy_optimized.py --skills-dir skills --rollback 20261111T120000Z
```

### 5. Nightly Evaluation (`.github/workflows/dspy-eval.yml`)

Runs daily at 2 AM UTC:
- Boots agent with faux model
- Runs 15 golden cases
- Uploads results as artifact
- Fails if accuracy < 80%

## Full Loop Workflow

1. **Production** → Agent runs, telemetry auto-exported to JSONL
2. **Weekly** → Run `curate_dataset.py` to extract new golden cases from telemetry
3. **Nightly** → DsPy eval runs against golden cases, detects regressions
4. **On failure** → `optimize_prompts.py` suggests improvements, generates few-shot examples
5. **Human review** → Review optimized skills in `eval/optimized/`
6. **Deploy** → `deploy_optimized.py` applies with backup + rollback
7. **Monitor** → Next nightly eval confirms improvement

## Running Locally

```bash
# 1. Run agent (generates telemetry)
instinct dev --port 8099

# 2. Curate dataset from telemetry
python eval/dataset/curate_dataset.py --state-dir /tmp/instinct-local

# 3. Run evaluation
python tests/dspy/eval_agent.py --url http://127.0.0.1:8099 --cases tests/dspy/golden_cases.json

# 4. Optimize prompts
python eval/optimization/optimize_prompts.py --url http://127.0.0.1:8099 --cases tests/dspy/golden_cases.json

# 5. Preview deployment
python eval/deploy/deploy_optimized.py --skills-dir skills --optimized-dir eval/optimized --dry-run
```
PYEOF
echo "Created eval/README.md"