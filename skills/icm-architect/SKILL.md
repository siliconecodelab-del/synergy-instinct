---
name: icm-architect
description: Design any process, idea, or body of knowledge into an ICM (Interpretable Context Methodology) workspace where folder structure is the agent architecture, or restructure an existing folder into one. Use for "ICM this", "structure this for agents", "build me a workspace", "turn this into stages", "make this editable for the next agent".
---

# ICM Architect

Build workspaces where the folder structure does the orchestration. One agent, reading the right files at the right moment, replaces a multi-agent framework: numbered folders carry sequencing, hierarchy carries context scoping, plain markdown files carry state. A person can open any folder and see what state the system is in, because state is just files.

Method: Interpretable Context Methodology (Van Clief & McDermott, arXiv:2603.16021). Runs in any agent or model that can read files — nothing in a workspace depends on one vendor's tools.

## The invariants

Every ICM starts from these ten. Break one on purpose only, and write why in the nearest `CONTEXT.md`.

1. **One folder, one job.** Each folder does a single step or holds a single kind of thing, and states its own purpose in a file inside itself. The structure is the documentation.
2. **A small, stable entry file.** `AGENTS.md` at the root answers "where am I, where does everything live, where do I go for task X" and nothing else. Under ~60 lines; it routes and never holds content.
3. **Numbering encodes order.** `01_`, `02_`, … where sequence matters.
4. **Every working folder has a contract.** A `CONTEXT.md`: what it reads (inputs), what it does (process), what it writes (outputs), how it is checked.
5. **Factory vs. product.** Reference material (rules, voice, schemas: stable across runs) lives apart from working artifacts (outputs, drafts: new every run). Configure the factory once; the product is what each run emits.
6. **Every step ends at a check.** Each output is a plain file a person can open, edit and save. Nothing moves on until it passes the check its stage names: a person, a script, or a small model. A check that isn't a person writes `check.md` beside the output, first line `pass` or `fail: <why>`; a fail stops the run there.
7. **Load only what the step needs.** A step reads its contract, its references and its inputs, never the whole workspace — under about 8,000 tokens. Prevent, don't compress.
8. **Plain text, linkable, queryable.** Markdown + YAML frontmatter. One home per fact; a link beats a copy. Links are relative and must resolve.
9. **Status lives on disk.** What exists, or one status line in the file it describes. Generated indexes are rebuilt by script, never hand-edited.
10. **Instantiate by copying.** A new unit of work is a copy of a template, not a blank page.

## Choose a mode

- **Build**: from a described process, idea, or problem.
- **Restructure**: an existing folder, repo, or vault that needs ICM structure.

## Three primitives

Every ICM is built from three things:

- **Sequence**: numbered folders; each step's `output/` is the next step's input.
- **Shelf**: a folder of same-shaped files, each copied from one template.
- **Catalog**: a small file that points down and stores no content: `AGENTS.md`, a `CONTEXT.md`, a generated index.

Forms are recipes over the three. Nest them freely.

| Form | Built from | Reach for it when |
|---|---|---|
| **Pipeline** | a sequence | the same steps run again, a deliverable each run |
| **Record library** | a shelf of records with a status line each | the unit is a record that accumulates (person, client, session) |
| **Knowledge bundle** | shelves of linked notes, often filled by a sequence from sources | the product is the knowledge: how someone thinks |
| **Context map** | shelves of teams, processes and data, linked by `consumes:`/`produces:` | the subject is an organization |
| **System map** | shelves of nouns and verbs plus an impact index | a tree later agents will edit |

## Build mode

**1. Extract the structure from dialogue.** Surface theirs, don't impose one. Ask:

- What is the repeating unit of work? (an episode, a client, a report, a person?)
- Walk me through one run, start to finish. Where do you stop and check before continuing?
- What stays the same every run vs. what is new every run?
- What does "done" look like: what artifact leaves the workspace?

Their pauses become stage boundaries. Their "I always check X before Y" become checks.

**2. Pick the form.** Choose from the table above by the repeating unit.

**3. Scaffold the smallest structure that carries the work.** Do not create empty folders or speculative depth. Three real stages beat seven imagined ones. If the whole job fits in one saved prompt, say so and don't build a workspace at all.

**4. Write the contracts.** Root `AGENTS.md` (identity + routing). Root `CONTEXT.md` (the pipeline). One `CONTEXT.md` per working folder. `setup/questionnaire.md` if the factory needs configuring per user. Inputs are exact backticked paths, split into working (this run) and reference (every run).

**5. Validate with the walk test** (below).

## Restructure mode

**1. Inventory before touching.** List the tree. Never delete or move in this pass.

**2. Find the hidden form.** What is the repeating unit? Where does work enter and leave? Extract the real pipeline, don't replace it.

**3. Classify every file:**

- **Catalog**: identity and routing (becomes `AGENTS.md` / index files)
- **Contract**: how a step works (becomes `CONTEXT.md`)
- **Factory**: stable reference (goes to `_shared/`)
- **Product**: run-specific artifacts (goes to a stage's `output/` or a record folder)
- **Dead**: stale, duplicated, superseded (propose `_archive/`, never delete)

**4. Find what points at each file before proposing a move.** Check links, sibling `../` paths, symlinks, consumers outside the tree. Nothing in the tree names outside consumers — ask the owner.

**5. Propose before moving.** Present the target tree and a migration map (old path, new path, role, referrers found). Get approval.

**6. Migrate: copy, verify, then remove.** Copy to the new home, verify parity, then remove the original leaving a link where anything referred to it.

**7. Validate with the walk test.**

## The walk test

Walk it cold, as an agent with no memory:

- Open the root. Can you answer *where am I* and *where do I go* within the entry file plus at most two more reads?
- Pick any working folder. Does its contract name exact input paths, the job, the output, and the check?
- Can you state status purely from what exists on disk, including any `check.md` verdicts?
- Is any routing file carrying content? Move it to a shelf; leave a pointer.
- Is any fact stored in two places? Pick one home; link from the other.
- Does one contract plus its inputs stay under about 8,000 tokens?
- Is every broken invariant explained where it breaks?

If a step fails, fix the structure — move or split files until the walk works.

## Guardrails

- **Don't over-structure.** The ladder runs: chat, then a saved prompt or skill, then folders and one agent. Only climb when the rung below is genuinely automated and repeating.
- **Let it harden.** A step that is code names its command, run from the workspace root. Fold a stage nobody edits; script a check that never fails; split a contract that keeps growing.
- **Know where ICM loses.** Real-time multi-agent collaboration, high-concurrency serving, and automated mid-pipeline branching need framework code. ICM is for sequential, checked, repeatable work.

## Target tree (smallest that carries the work — Pipeline form)

```
workspace/
├─ AGENTS.md              identity + routing table
├─ CONTEXT.md             the pipeline in one screen
├─ stages/
│  ├─ 01_research/   {CONTEXT.md, references/, output/}
│  ├─ 02_script/     {CONTEXT.md, references/, output/}
│  └─ 03_production/ {CONTEXT.md, references/, output/}
├─ _shared/               factory: voice.md, rules.md
├─ _tools/                scripts the stages call
└─ setup/questionnaire.md  configures the factory once
```

A stage CONTEXT.md contract:

```markdown
# 02_script - turn research into a script

One job: write the script from the research output.

## Inputs
- Working (this run): `../01_research/output/research.md`
- Reference (every run): `../../_shared/voice.md`

## Process
1. If an input is missing or empty, stop and say which.
2. Draft to the structure, in the tone of voice.md.
3. Keep it under 90 seconds spoken.

## Outputs
- `script_draft.md` -> `output/`

## Check
A person reads the draft aloud and confirms the argument order survived from research.
```

## Do not

- Do not create folders for stages that don't exist yet.
- Do not make empty "misc" buckets or speculative depth.
- Do not restate reference material inside a contract — point at it.
- Do not build a workspace before the process has actually repeated.
- Do not copy the same fact into two files — pick one home, link from the other.
