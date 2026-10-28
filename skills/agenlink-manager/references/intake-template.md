# Project intake template

Save a local draft, then run `agentlink project submit --file /path/to/draft.yaml`. The CLI creates the registry intake and notifies PM automatically; no separate agentmsg message. Use `--check` for validation only.
Use `intake.schema.yaml`; projects reference the record through `intake: intake.<slug>`.
Phased approaches are not allowed and will be rejected. Propose one complete outcome; logistics describes how to reach it, without separately accepted phases.
Before submission, the requestor reads relevant completed retrospectives and their conclusions in Dev Projects. Record at least one lesson and how it shapes a bounded scope or faster delivery; reuse existing safeguards instead of adding duplicate process.
Before building more, make one small example work in the real app (or the tool that will use it). Look at the result. Check that its inputs agree. Check one measurement by hand and time the test. If any of those fail, fix the example before expanding.
Link the example, actual output and test results in feasibility evidence. If it cannot run yet, mark the assumption open and make that example the first task. For visual work, include a reference picture and name what should match.
Default to full autonomous delivery with minimal human interruption. The requestor agent accepts the result against the references and exit criteria; agents carry it through integration and closeout. The requestor decides physical and technical methods within the agreed goal and explicit constraints. Batch genuine goal, budget or requirement changes into one decision; do not escalate implementation choices. Do not add human approval checkpoints unless explicitly requested for this project. Escalate only a concrete decision that cannot be resolved within the authorized scope.
Write technical prose only: describe the system, problem and result. No I/we/you, personal names, owner narration or conversation quotes. Put the original project request only in `authorization.request`; put its file/message reference in `authorization.source`. The CLI rejects personal narration in technical prose.
Name the files each check reads. Give consecutive work to the same worker when possible; keep its checks separate. Use the cheapest test that answers the question. See [test and capture setup](worker-cli.md#baseline-fixture-and-capture-preflight) for baseline checks.
Resolve scope/design questions before submission. Technical feasibility gaps must name a resolution step and success condition; they are not assumed passes. Empty lists explicitly mean none. PM assigns workers, branches and detailed acceptance criteria later.

```yaml
# yaml-language-server: $schema=../../schema/intake.schema.yaml
identity:
  key: intake.replace-with-slug
  name: ""
  submitted_by: ""
authorization:
  request: "" # Exact direct project-creation request; provenance, not technical narrative.
  source: "" # File or message reference.
goal: ""
logic:
  problem: ""
  proposed_solution: ""
  research_evidence: [] # Source files/links, including reference pictures or real-world examples for visual work.
  exit_criteria: "" # Logical description of completion; for visual work, say what should match the references.
  retrospective_review:
    - retrospective: retrospective.replace-with-relevant-project
      lesson: "" # What helped or prevented successful, timely completion?
      application: "" # Concrete scope choice or delivery safeguard used in this intake.
  engineering_assumptions:
    - statement: Package measurements use the declared grid and units; no visual-only proxy counts as measured accuracy.
      verification: measurement # measurement | calculation | simulation
      basis: [docs/research/package-feasibility.md]
      applies_to: [package-contract]
  feasibility:
    assumptions:
      - id: representative-package
        statement: One small package opens in the real loader, contains the required fields, and stays below the stated memory limit.
        state: supported # open requires a real resolution_step, not assumed success
        evidence: [docs/research/package-feasibility.md]
        resolution_step: no-resolution-required
        success_condition: The loader opens the sample; one decoded value matches the hand calculation; elapsed time and peak memory are recorded.
    budget_bounds:
      - resource: peak memory
        bound: At most 1 GiB for the small test package.
        basis: docs/research/package-feasibility.md
logistics:
  approach:
    - id: package-contract
      owner: specialist
      deliverable:
        artifact: docs/package-spec.md
        description: Versioned package specification defining data encoding, units, filenames, required fields and compatibility, with sample package and validation command.
      completion_condition: The sample package passes the specification validation command; the specification includes every field required by the consumer loader.
      depends_on: []
      dependency_artifacts: [] # For each dependency: {step: producer-id, artifact: path/from/producer, release_condition: delivered-and-hashed}
      completion_kind: implementation # implementation | integration | outcome
      experiment_budget_minutes: 3 # REQUIRED for each AC step: choose an integer 1..4
      # validation_group: surface # Optional: same artifact, checked together.
  dependencies: []
  resources: []
  constraints: []
  risks: []
affected_areas:
  - repository: ""
    components: []
    interfaces: []
out_of_scope: []
open_questions: []
```

`submitted_at` is required on saved intakes. The submission CLI assigns the UTC timestamp automatically; omit it from drafts. Retries preserve the original timestamp.

Each approach step has exactly one accountable owner, a tangible deliverable, an observable completion condition and dependencies by step ID. The example above illustrates the structure: replace it with your researched deliverable. Resolve design during research; do not assign joint agreement, coordination or discussion as a task. Consumers implement against the delivered artifact.

The CLI rejects prose-only steps, missing fields, multiple/group owners, missing artifact paths, vague coordination outcomes, unknown dependencies and dependency cycles. Completion wording is checked heuristically for an observable result. These checks catch common submission mistakes; they cannot establish that an artifact or its proposed validation is sufficient or correct.

New submissions require evidence-backed feasibility assumptions and resource bounds, engineering verification/abstraction assumptions, artifact release contracts, completion kind and an explicit 1–4 minute experiment budget per step. These are delivery steps toward one complete outcome, not separately accepted phases. The requestor assesses technical sufficiency; the CLI checks shape, references and budgets. Keep independent implementation and consumer-parity gates separate from final integration/operational gates.

Measurement assumptions must cite their evidence in `basis`. Use `validation_group` only for coupled steps.

For a fresh installation with no completed retrospectives, omit the optional
`logic.retrospective_review` field. Do not supply an empty array (the original
schema requires at least one entry when present), and never invent past projects.
Once completed retrospectives exist, submission requires actual lessons from them.
