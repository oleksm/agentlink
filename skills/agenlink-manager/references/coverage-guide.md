# Outcome coverage and measurement evidence

The requestor root independently validates the delivered outcome against research logic. This map helps temporary workers cover the goal before that review. Evidence-ready means measurements are available, not that the root accepted the result.

The requestor root reviews and submits `agentlink work coverage-plan PROJECT --file plan.yaml`. Quote every original exit-criteria clause verbatim in at least one outcome. Additional proposed-solution clauses may be mapped too. Cases copy their AC pass condition exactly; methods explain the check without adding requirements. Declare consumed implementation paths, measurement tools, configuration, dependencies and datasets. The CLI checks traceability and hashes; the root checks semantic sufficiency. Keep post-acceptance lifecycle directions in logistics, not acceptance coverage. Do not weaken statements or remove cases. Use one bounded outcome per independently measured claim.

```yaml
- id: real-edge
  logic_ref: exit_criteria
  statement: Exact clause copied from the original exit criteria.
  owner: worker-PROJECT-consumer
  criterion: C5
  measurement: Measure edge pixels on actual candidate output at each required view.
  required_scope:
    dataset: real
    products: [consumer, product]
    cases: [lod-100km]
  case_checks:
    - case: lod-100km
      condition: Exact observable_pass_condition copied from C5.
      method: Measure the edge at the specified camera.
  inputs:
    - { product: consumer, path: src/consumer }
    - { product: consumer, path: tools/measure.mjs }
    - { product: product, path: tools }
    - { path: /absolute/package/manifest.json }
```

`criterion` is internal worker routing. The root reviewer does not review the delivery C-number checklist.

Each mapped temporary owner publishes `agentlink work coverage-report PROJECT --file report.yaml`:

```yaml
outcome: real-edge
scope:
  dataset: real
  cases: [lod-100km]
candidates:
  consumer: FULL_CURRENT_COMMIT_SHA
  product: FULL_CURRENT_COMMIT_SHA
result: pass
finding: Measured edge width and blend count on the actual candidate; exact result and threshold.
evidence:
  - /absolute/project/output/measurement.json
  - /absolute/project/output/comparison.png
```

Use all products consumed by the measurement, not only the code doing the check. Include immutable input identities in the evidence. A report must include its owner's product. Synthetic evidence cannot satisfy a real-output case. Partial reports only cover their listed cases. A newer failed or stale report supersedes an earlier pass for those cases. Changed evidence, declared inputs or contracts reopen coverage. Unrelated commits reuse the original report without republication. Directory hashes include added/deleted files; external files use SHA-256. Symlinks and submodules must be declared as separate consumed contents. Reports without a reviewed input scope retain exact-candidate checks. Files are hashed and browsable; reports and plans update registry views automatically. `work coverage-status PROJECT` lists remaining cases. Reports do not complete delivery ACs; continue normal `work update` checkpoints.

Workflow assigns missing coverage to its temporary owner and waits for all required cases before final root review. Missing contracts go to the requestor root for review; measurement work stays with temporary workers. A human-only approval clause maps to preparation of the side-by-side evidence; evidence readiness never grants human approval. Preserve the explicit project owner hold.

For final review, each failed logical finding names `outcomes: [real-edge]` or `affected_artifacts: [evidence-ID]`. Ordinary `evidence` citations can include passing context and do not mark it faulty. The tool routes only each finding's named outcomes/artifacts to their temporary delivery owners. The root never supplies AC IDs. Split findings with different faulty outputs into separate entries; missing measurements can name the planned outcome even when no defective artifact exists yet.

Gate correction proposals include `coverage_impact`: what ranges/cases change and what original outcome coverage remains missing. Approving a component gate never deletes outcome requirements. The independent root still judges the original logic.
