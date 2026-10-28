# Worker lifecycle and progress CLI

PM initializes workers before dispatch. Root agents are read-only context sources.

Run autonomously with a bias for delivery. Resolve routine choices and peer dependencies yourself. The requestor agent accepts the outcome; do not wait for human confirmation unless this project explicitly requires it. Escalate only decisions outside the authorized scope.

```sh
agentlink workers workspace sample-project product
agentlink workers init sample-project specialist --product product --name worker-specialist
agentlink workers start sample-project worker-specialist
agentlink workers verify sample-project worker-specialist
agentlink workers status sample-project
```

Workspace uses the recorded base and branch; existing workspaces must match. Init records the worker before registration. Start creates a native fork, preserves source identity, and refuses duplicate launches/re-forks. Verify checks distinct binding, worktree and saved child resume command. Real communication probes and assignment acknowledgement remain required before active work. These individual lifecycle commands do not commit, merge, publish or retire resources. The workflow runner below composes them with probe handling, dependency launches and guarded closeout.

Workers use their own bound `AGL_AGENT` and this absolute package CLI, regardless of product worktree:

```sh
agentlink work show project.sample-project
agentlink work update project.sample-project C1 in-progress --detail 'Implementing package validator'
agentlink work update project.sample-project C1 completed --artifact /path/spec.md --evidence /path/check.log --detail 'Candidate SHA; sample and rejection checks pass'
agentlink work update project.sample-project C1 blocked --blocked-by worker-registry --detail 'Need gate field units in the delivered contract'
agentlink work ask project.sample-project worker-registry --summary 'Please confirm gate field units' --see /path/spec.md
```

Only the assigned temporary worker can update a criterion. Completion requires actual artifact/evidence files and hashes; it does not mark requestor acceptance passed. Status history saves immediately; one background publisher combines page updates. Blockers notify only the named peer. Completion queues dependency-ready tasks to peer workers once, not PM or roots. The enabled workflow runner monitors the registry and starts planned workers when ready. A peer already running can proceed when its prerequisites are completed. Ordinary coordination uses `work ask`; routine progress and completion use `work update`, not messages to PM.

Updates serialize with the lifecycle script through the project's workers.lock. Keep artifact paths inside the project worktree/output directory. A page/transport failure is reported; progress already saved remains durable. Retry completion to retry unsent dependency notifications. CLI changes are left for the PM's serialized registry commit, not worker commits in the shared registry workspace.

## Automatic workflow runner

```sh
agentlink service render --file workflow.service
agentlink workflow enable sample-project
agentlink workflow tick sample-project
agentlink workflow disable sample-project
```

The workflow service checks enabled projects every 30 seconds. It reads the intake dependency graph and worker CLI events, verifies completion evidence hashes, forks ready planned workers, verifies native child bindings and real worker-to-worker probes, and dispatches scoped assignments once. It records transitions in the project YAML and rebuilds registry views. Runtime workflow.json only holds retry/probe/notification records.

Workers record a progress update at least every 3 minutes while working. Blockers or 15 minutes without expected progress/startup/acknowledgement create a durable blocker and notify the responsible temporary worker first. Worker recovery follows the two-cycle, ten-minute protocol below; unresolved criterion issues do not use a separate earlier PM escalation. Issues with no worker owner go to PM. New progress clears stale-progress alerts with a captured event as evidence. The PM facilitates exceptions; completed dependencies advance without a PM conversation. Missing/changed evidence prevents release. `--stall-minutes` changes the threshold for a manual tick. Duplicate launches and dispatches are suppressed; native launch failures require inspection rather than blind re-forking.

When all deliverables are completed, the runner generates a review template tied to the current logic, criteria, artifact hashes and candidate commits, then asks only the requestor for final acceptance. Active remains in progress until every AC has passed artifact-versus-logic review. The requestor reviews the candidate artifacts and explicit human gates, then records its decision:

```sh
agentlink work accept sample-project --review /path/logic-review.yaml --evidence /path/acceptance.md --detail 'Exact candidate commits reviewed; required criteria passed'
```

If an explicit owner hold has actually been approved, add `--release-holds` and include that approval in the evidence. Only the requestor can accept. Completion updates from workers never grant acceptance or release holds.

After all criteria pass, no open blockers/holds remain and accepted commits still match clean candidates, the runner fast-forwards clean main targets, recording each integration separately. Divergence, unrelated dirty changes or a changed candidate stop that integration and notify PM. It never pushes or resets a branch.

Before removing resources it archives worktree evidence and writes a postmortem with criteria, commits, timeline and recorded issues. It requests each temporary worker to stop jobs and attest idle readiness:

```sh
agentlink work retire-ready sample-project --detail 'All jobs stopped; useful artifacts preserved; idle'
```

The runner verifies exact child binding, PID/start identity and absence of non-runtime child jobs before stopping its dedicated tmux session. It archives registration, retains native histories/mail and routes late messages to PM. Only clean worktrees with accepted commits reachable from target main and their merged project branches are removed. Runtime/lock evidence is retained. The project is marked closed only when acceptance, integration, postmortem and cleanup checks all pass. The retired names stay reserved through aliases; use fresh names for later projects.

Status reasons are short labels (for example `C1 acknowledgement` or `Reopening for typed-schema incompatibility`). Use `--reason` (maximum 120 characters) for the label and `--detail` for the full report. Without `--reason`, the CLI shortens the detail. Completed rows automatically link their evidence; full reports remain in events.

The Status table shows Tokens spent from native worker usage snapshots. Workflow ticks and work updates capture deltas per AC; root/inherited counters are baseline-only. Displayed counts include uncached input plus output; cached input reads are excluded. Cache creation remains newly processed input. Raw snapshots retain both input and cached-input counters. The tooltip identifies partial tracking; unavailable historical AC usage stays blank. Hover for input/output/cache and baseline time. Runtime snapshots are stored in the project token-usage.json; attributed totals are retained in each criterion token_usage.

AC creation through worker preparation automatically attaches logic_refs for proposed_solution and exit_criteria. The requestor fills every review check with a finding and current delivery evidence IDs; unresolved checks remain pending/fail. The CLI rejects incomplete, failed, stale or changed-artifact reviews. To generate a fresh template manually, use `agentlink work review-template sample-project --output /new/path/review.yaml`. Integration rechecks the accepted review fingerprint and evidence hash. Scripts validate coverage and identity; the requestor performs the semantic review.

Changed completion evidence automatically invalidates the delivery and affected running/completed dependents. The runner routes revalidation to their temporary workers, blocks new dependency releases, and notifies dependents when replacement prerequisites pass. It never restores completed status without a fresh worker completion/evidence update.

The requestor returns failed logic review findings with `agentlink work reject PROJECT --review /path/review.yaml --detail "Review findings"`. Mark affected AC rows `result: fail`, with concrete logic findings and current delivery evidence IDs. The CLI records failures; the runner routes them to workers, invalidates affected dependent work, and generates a fresh snapshot-bound review after replacement deliveries.

## Worker health and recovery

Use a concise structured checkpoint on active work:

```sh
agentlink work update PROJECT C3 in-progress --detail 'Measured results and next experiment' --action 'Calibrating sample cases' --progress 'Unknown samples reduced from 256 to 30' --next-checkpoint 'Full classification check' --check-in-minutes 3
```

Optional `--job-pid PID --job-log FILE` registers a running job; PID start identity prevents confusing a reused PID with the old job. Use `--waiting-on worker-name` for a peer dependency; `--outcome no-progress` records a failed attempt. Three reported failed attempts trigger a stall. Identical progress text does not reset the meaningful-progress clock. Tokens are never a health signal.

Each tick reads only recent native tool-event metadata and registered job activity. Status Details shows working/waiting/stalled/unresponsive health, current action, last reported meaningful progress, next checkpoint and due time. Missing activity is an observation, not proof that a process is dead. No automatic kills or replacement forks occur; missing bound child terminals use the guarded runtime supervision below.

For stalled/unresponsive work or a worker-owned blocked delivery, the runner performs two recovery cycles automatically. Each cycle has four steps, each with a fresh ten-minute window starting from its notification:

1. Investigate sample rebuild cost; reduce experimental scope and non-primary factors while preserving the primary failure and final acceptance criteria.
2. Add targeted traces/debug tooling to detect inconsistencies sooner and increase experiment/variation throughput.
3. Pause implementation, search the web using primary sources, account for missing factors, and record cited findings and the next experiment.
4. Review the overall goal and research logic: what the current gate protects/blocks and whether its measurement, method, threshold and coverage are reasonable. If misaligned, publish a concrete old/new gate correction with supporting evidence and tradeoffs. Preserve the intended outcome. Record the correction as an explicit project decision before applying it and revalidating; no silent waivers or automatic passes.

The eight attempts are durable and deduplicated; missed ticks do not skip steps. Routine activity, progress text and extended worker checkpoints do not reset the recovery clock. Publish findings through work update with --check-in-minutes 3. If the blockage is actually resolved, report in-progress --outcome progress with concrete --progress findings; verified completion also ends recovery. After the eighth ten-minute window, automation asks the worker to pause retries and sends PM an OWNER DECISION REQUIRED escalation to present to the human owner. It does not start a third cycle or weaken criteria. Existing dependency waits remain attached to their responsible worker. No automatic worker kills or reforks occur; guarded resumption of an absent bound child is separate runtime supervision.

Delivered ACs enter `acceptance` in Status History and Status; dependency scheduling still uses verified delivery events. Only the requestor's successful artifact-versus-logic review changes those ACs to `completed`. Acceptance retains the existing human gates.

## Concurrent projects

New projects generate `worker-<project>-<root>` names when `agentlink workers init` omits `--name`; explicit names must retain the project prefix. Long names are bounded with a deterministic hash. The isolation policy keeps any explicitly configured compatibility exceptions; the package ships none. Retired aliases cannot be reused.

Integration and cleanup acquire the repository’s canonical Git lock and the project’s own lock. Registry publishing is separately serialized and HTML is atomically replaced.

Blocked delivery and worker health are independent. Recent worker activity or an advancing registered job can show **working on fix**; an invalid upstream dependency shows **waiting** with the AC and worker named. Overdue checkpoints, repeated failed attempts, and stale meaningful progress still produce **stalled** even when tools are active. Details displays live activity/progress ages, reported progress text, due/overdue checkpoint countdowns, dependency and current recovery stage. Tool activity never resets the meaningful-progress timestamp.

Latest Status keeps health as a compact badge. Workflow Actions follows Status History and renders timestamped workflow events and worker findings newest first, with evidence links. Notifications are recorded automatically; worker updates preserve action/progress/checkpoint details in the event history rather than expanding the latest status cell.

## Visual evidence during progress

Open the actual result. For visual work, put the frame beside the reference at the same camera and scale. Name what is wrong and where. Passing numbers do not excuse a broken picture. If the frame is missing, ask for it. For other work, inspect the output or diff.

At review, choose the next small test from what failed. Read the failed attempt if needed to explain it. Do not interrupt a running test.

Publish the comparison while work is in progress using work update --artifact /absolute/comparison.png --evidence /absolute/measurements.json --detail 'What changed; observed result; next experiment'. Keep previews in project-specific output, link exact files rather than a directory, retain previous comparisons, and include source data/reproduction details. Images and supported documents are browsable in Workflow Actions; status stays compact. A running experiment gets a checkpoint every three minutes and a comparison on completion.

## Gate proposals and requestor roles

The temporary worker forked from the intake requestor represents its research context for gate decisions. The permanent root is not contacted for these intermediate decisions. Final validation explicitly marked `requestor_review: true` (a dedicated requestor-review criterion) and final project acceptance belong to the actual requestor root, which receives a context/evidence handoff when prerequisites pass. Human approval requirements remain intact.

Submit a gate correction through the CLI, not a PM message. Write a YAML proposal:

```yaml
condition: Exact replacement observable pass condition
verification_method: Reproducible measurement and comparison procedure
rationale: Why the old gate is inconsistent with the unchanged overall goal and research logic
goal_preserved: true
peer: worker-validator
evidence:
  - /absolute/path/calibration-review.md
  - /absolute/path/measurements.json
```

```sh
agentlink work propose-gate sample-project C4 --proposal /absolute/path/proposal.yaml
agentlink work review-gate sample-project gate-ID --decision approve --evidence /absolute/path/peer-review.md --detail 'Independent findings'
agentlink work decide-gate sample-project gate-ID --decision approve --evidence /absolute/path/requestor-decision.md --detail 'Why the correction preserves the intended outcome'
```

The first command returns the stable gate ID. Workflow routes the saved proposal to its independent temporary peer, then routes an approved peer review to the temporary requestor representative for the decision. Both review commands also accept `reject`. The proposer cannot review its own evidence. A requestor who authored the proposal can decide only after another worker approves the evidence. Hashes and the original gate/logic are checked again when deciding. Goal/scope changes require the human owner; this CLI cannot edit goal or logic.

Approval atomically records the decision, applies the new condition/method, and reopens affected started/delivered criteria for fresh validation. It never marks acceptance passed. Rejection leaves the gate unchanged. Open gate proposals prevent final acceptance. Decisions, findings and artifacts are visible in the registry and Workflow Actions. No routine PM/root mail is required for the proposal path.

## Independent final outcome validation

The actual requestor root validates the delivered project against its own intake logic and exit criteria, independently of the worker C-number delivery plan. `work review-template` produces goal, research logic, candidate artifacts and logical findings (`checks`: logic_ref, result, finding, evidence), not one review per AC. Add enough findings to address every logical exit condition and cross-artifact behavior. `work accept` requires all findings to pass on the exact snapshot; `work reject` routes failed artifact-linked findings to temporary owners internally. Worker delivery checks remain preparation evidence, not the root acceptance checklist. Validating is one project-level step; acceptance does not duplicate delivery ACs into it.

## Outcome coverage for all projects

All enabled active projects and future projects use the shared [coverage guide](coverage-guide.md). The workflow asks the temporary requestor representative for a complete plan, routes missing measurements to temporary owners, and blocks final review until evidence covers every required case. CLI: `work coverage-plan PROJECT --file plan.yaml`, `work coverage-report PROJECT --file report.yaml`, `work coverage-status PROJECT`. Existing artifacts can be reused when hashes, candidate commits and scope match; no automatic reruns or acceptance. Root rejection findings identify failed outcomes or affected artifacts separately from supporting citations.

## Worker runtime supervision

Worker tmux servers launch in persistent user systemd scopes, outside the short-lived workflow service. Every tick checks starting/active workers for missing managed terminals. A saved, distinct child can resume only when its exact native session has no live process; it is never re-forked. One recovery is allowed per child within ten minutes. Missing binding, a potentially live duplicate, unsafe resume or another disappearance within that window escalates immediately to PM. Permanent roots are never resumed or modified by this supervisor. Findings and recoveries appear in Workflow Actions. Communication verification remains mandatory after resumption.

Coverage gaps are visible early, but measurement tasks dispatch only after their delivery dependencies exist. Future-step waits do not constitute failed experiments. Runtime notifications use zero additional delivery delay so project locks are released promptly for worker checkpoints.

## Automatic job and contention checks

For executing work, workflow observes descendants of each verified temporary worker's dedicated pane. PID/start identity prevents reuse errors. It records process names, CPU counters and affinities, never command text or root-process contents. This finds active compilers/build jobs even without `--job-pid`. An overdue checkpoint with live jobs prompts the worker to publish actual stage/results, register PID/log and set its next checkpoint; an exited job with an older checkpoint prompts an exit-result report. Neither CPU activity nor job exit marks work completed or resets meaningful-progress time.

Across enabled projects, advancing jobs pinned to small overlapping CPU sets trigger one worker action per contention episode: check wall/CPU time and select a non-overlapping allocation within the existing budget, or report the constraint. Persistent overlap after ten minutes escalates to PM for allocation. The observer never increases resource limits, changes affinity, kills jobs or touches root processes. Observations expire after two minutes. Actions and escalation are recorded in Workflow Actions; original experiment recovery continues independently.

## One active AC per worker

Workflow reserves one execution track per temporary worker. Dispatch, progress/completion, coverage work and gate reviews obey the same reservation. Other ACs queue; multiple independent tasks do not imply concurrent execution by one agent.

To take another task while blocked/waiting, stop jobs on the original task and save its checkpoint, then acknowledge the safe pause:

```sh
agentlink work pause PROJECT C4 --waiting-for C2 --detail 'Saved checkpoint; no C4 jobs running; waiting for C2 artifact'
```

The worker attests that unregistered jobs are also safely stopped. A live registered job prevents pause. Unfinished intake dependencies are linked automatically if `--waiting-for` is omitted; for other waits supply the explicit AC. For an external condition that the scheduler cannot infer, signal it with `work resume PROJECT C4 --detail 'Required input now available; evidence ...'`.

When the original dependency clears, workflow requests a safe pause of the fallback AC. Only after that acknowledgment does it reserve and release the original track. The fallback remains paused until the original finishes or yields again. Never continue both in parallel. Paused health is explicit on the project page; runtime activity on one AC does not imply progress on its paused siblings. Existing concurrent tracks require real pause acknowledgments.

## Token checkpoints and context maintenance

Workflow counts uncached input plus output, excluding inherited history. Every AC reaching another 100,000 observed uncached tokens receives a nonblocking advisory review by the permanent requesting root agent (`identity.submitted_by`), never a temporary worker or a different source root. The root reviews goal alignment, gates, evidence and direction using `work token-review PROJECT AC --file response.yaml`. The response requires `threshold` (from the request), `decision: resume|hold`, and nonempty `goal_review`, `gate_review`, `direction`. The original owner goal, exit scope and human holds remain binding.

An optional `gate_update` applies a root-approved correction: `condition`, `verification_method`, `rationale`, `coverage_impact`, `goal_preserved: true`, and `evidence: [existing-file]`. It preserves the prior gate in the review artifact and invalidates affected deliveries and old coverage; it never accepts artifacts automatically. A scope/goal change beyond the original owner intent remains a human decision. Guidance and corrections are recorded as browsable Workflow Actions.

At task completion and every 100,000 observed uncached tokens per worker, workflow holds new implementation for native context compaction. Status, blocker reports, evidence and completion publication remain available; ownership, dependency and acceptance checks still apply. Save a checkpoint containing goal/logic, current AC, evidence paths, blockers, next action and latest root guidance. Registered jobs defer compaction; once they finish, run `work compact-ready PROJECT --checkpoint FILE`, then end the turn. The controller waits for an idle exact-bound child session, invokes `/compact`, verifies a native compaction event, and wakes the same worker to read the checkpoint. It never forks, restarts or interrupts a busy session. Missing acknowledgment, unsupported runtime state or missing completion evidence escalates after ten minutes; no false success or automatic release. A blocking root review completes before compaction; advisory reviews do not reserve execution.

### Review roles and actionable guidance

The implementing temporary worker checks its own artifacts and submits evidence. The permanent requestor root reviews direction at the token checkpoint; its source root supplies context only. `resume` permits continued work only; it does not accept an AC, bypass a dependency, authorize a merge, or release owner holds. Final outcome acceptance remains with the actual requestor root.

Generate a response with `work token-review-template PROJECT AC --output RESPONSE.yaml`. Submit that response, not the full request packet. Specify the next bounded checkpoint and the dependency where work must stop. Refer to temporary worker IDs in the request packet's role map: a request to “registry” or “specialist” means that project's temporary peer for execution, using `work ask`, not the permanent root. Ordinary gate proposals retain independent peer/requestor review; the requestor root's evidenced `gate_update` during a token review is the explicit owner-authorized exception. A suggestion in prose is guidance and does not change the recorded gate.

### Failed-turn context and acceleration review

The review question is **“Given the actual attempts and failures, what could help this agent achieve its goal sooner?”** It is not a vote on whether the current course is correct. Investigate missing information, cheaper discriminating experiments, better tooling, dependency assistance and alternative approaches; identify the highest-value next change and expected benefit without relaxing the owner goal.

Before advising, the permanent requestor root reads the native turn packet, including calls, outputs and surrounding messages. The interval starts at the previous review (first review: worker project start); a chain links previous packets for unresolved failures. Failure highlights are heuristic and cannot exclude unflagged turns. Hidden reasoning is excluded; transcripts stay in local runtime storage, outside committed registry records.

`work token-review-template` includes `turn_manifest_sha256`, `reviewed_turns`, `failed_turn_review`, and `acceleration_review`. List every supplied turn ID, cite actual attempts in the failure analysis, then explain what would help the worker reach its goal sooner. CLI verifies the exact packet/files and required coverage before accepting guidance. This is an explicit review attestation, not proof of comprehension. Missing native history keeps the review held and alerts PM; a worker summary cannot substitute for failed-turn context.

Token intervals are configured in `workflow-policy.json`: root review per AC and compaction per worker. Both default to 100,000 uncached tokens. Open reviews retain their original threshold; subsequent reviews follow the configured interval.

### Conditional review holds

Use `decision: hold` with `release_after: [C4]` to authorize resuming once those ACs and the intake prerequisites have completed with valid evidence. The workflow records the verified release and queues the worker through normal compaction and single-AC scheduling. It does not change acceptance, gate conditions or owner holds. Unknown/self/duplicate references are rejected. A hold without this field remains explicit: when its recorded `waiting_for` dependency clears, workflow asks the reviewing root to release it and escalates after ten minutes without a response. It never infers permission from prose.

## Tracked peer artifacts

Use `request` for work needed from another temporary worker; reserve `ask` for short informational questions. Requests are durable project objects and pages, not mailbox-only conversations.

```sh
agentlink work request PROJECT C8 WORKER --owner-ac C7 --artifact adapter-review.md --detail 'Concrete required result and scope' --due-minutes 30
agentlink work requests PROJECT
agentlink work request-reply PROJECT REQUEST_ID --state acknowledged --detail 'Checkpoint and delivery plan'
agentlink work request-reply PROJECT REQUEST_ID --state delivered --artifact /absolute/adapter-review.md --evidence /absolute/check.log --detail 'Result and limitations'
agentlink work request-review PROJECT REQUEST_ID --decision accept --detail 'Verified requested result against evidence'
```

The requester owns its AC; the recipient must own the named existing AC. This grants no new file ownership, merge permission or authority to bypass gates. Use a concrete named artifact, not “agree.” Delivery pins artifact/evidence hashes. The requester checks quality and accepts/rejects; changed evidence invalidates verification. A rejected delivery routes back to the owner. Deadline handling notifies the responsible worker first and escalates after ten more minutes without resolution. Notifications and execution reservations respect compaction and one active AC per worker. Artifact review of an awaited artifact is allowed while implementation remains held.

Root reviews can use `decision: hold` and `release_requests: {mode: any, requests: [request-ID, request-ID]}` (or `all`). Only verified requests satisfy this condition. On release, workflow queues the same worker under its current bounded guidance. An `any` release allows only that bounded response; incomplete intake dependencies still prohibit claiming completion. Human approval, integration and acceptance gates remain unchanged. Existing prose holds are routed to the root once for explicit binding; no inferred authorization.

During compaction, `work update` stores the submitted update in `pending_updates` instead of discarding it. Workflow replays it after maintenance and slot/root-hold constraints clear. It verifies the original artifact hashes, unchanged goal/gate and absence of a newer worker update. Invalid/stale updates are preserved as rejected and routed back to the worker. Applying a completed update still means delivery, not acceptance. Duplicate queued submissions are idempotent. Do not repeat a rejected command or write directly to project YAML.

Every third token-review episode per AC (3, 6, 9...) requests immediate course correction: reduce task/project scope to a finishable outcome and salvage useful completed artifacts. Count actual review episodes, not token thresholds or amended responses. `token-review-template` supplies required `scope_correction` fields: retained_artifacts, dropped_work, reduced_task, reduced_project, finish_condition, changes_project_goal. The CLI rejects missing details. Goal-preserving reductions use bounded direction and evidenced gate_update. A changed original goal/exit logic creates an open owner scope decision and requires hold without automatic release conditions; workflow escalates that concrete proposal to PM. Existing in-flight reviews keep their original contract.

Final lifecycle step: `retrospective` replaces `closed` for current/new projects. After verified acceptance, integration and cleanup, workflow creates a pinned factual snapshot and review template, then requests PM review. Run `agentlink work retrospective PROJECT --file REVIEW.yaml` as project-manager to complete it. Required: summary, decisions_review, what_worked, what_did_not, and improvements (target, change, prevalidation, evidence, disposition planned/applied/not-needed). Record concrete intake-template corrections and automated pre-validation opportunities; never claim planned changes are applied. Stats are observed uncached tokens (also M), project worker native turns and review episodes, with explicit missing/partial coverage. Historical closed records remain readable and retained.

## Bounded work

Progress checkpoints are due every three minutes. Keep each check within its recorded AC and project budgets. Publish results and logs through the existing work and coverage commands.

## Owner actions in the registry

The registry on its configured loopback port runs `agentlink serve --workflow`. Project pages show **Action Required** above Workflow Actions: open human-owner decisions, explicit owner holds, approve/reject with directions, and a project direction form. Writes require a same-origin session token, lock the project, reject stale proposals, and preserve owner records/evidence. Duplicate request IDs do not create duplicate decisions.

Approval of a scope proposal records the human owner's decision and routes it to PM for application; it does not silently rewrite logic, accept artifacts or merge. Approval of a named owner hold releases only that hold and routes the existing requestor to finish independent acceptance. Rejection preserves a hold. Directions are recorded and routed to PM. Workflow picks up these actions on its normal service cycle; registry views rebuild asynchronously. The section itself fetches current actions without waiting for a page build. File-only browsing remains read-only.

### Approval follow-up

The workflow tracks owner UI approvals until the responsible agent records a disposition.
An outcome rejection is a disposition too; approval of an owner hold is not artifact acceptance.
After 3 awake minutes without a response it sends one reminder, and after 10 awake minutes
it escalates to PM. Delivery notices and unrelated PM alarms do not count as responses.
When the last owner hold clears, eligible blocked temporary workers receive a bounded
resume/reassessment request (one AC per worker). Existing review, context-maintenance,
dependency and track holds still apply. Scope changes and free-text directions go to PM
for application; approving them does not silently rewrite gates or accept artifacts.

### Retrospective writing: focus on the topic

Describe the intended result, actual artifacts and measurements, what worked, technical or workflow causes, trade-offs, and concrete improvements. Do not name the human user or recount approvals, permissions, personal blame, credit or responsibility. Describe a scope change by what was included and excluded; describe a delay by the missing transition, artifact or condition. For example: “coverage was ready but final review was not dispatched,” rather than assigning the wait to a person. Preserve failures and limitations. This applies to summaries, per-step reviews and the concluding document. Raw evidence and decision records retain their original provenance. Narrative validation checks submissions before publication.

### Coverage and coupled validation

Declare what each check consumes. Coverage verifies criteria; it does not add them. Review and merge the same candidate.

The requestor root submits changed `work coverage-plan` contracts. Each case copies its AC condition exactly and explains its method. The root checks that methods add no requirements and inputs include implementation, tools, configuration, dependencies and datasets. CLI checks structural traceability; it cannot prove semantic sufficiency.

Use the contract format in [coverage-guide.md](coverage-guide.md).

Publishing coverage automatically fingerprints declared inputs. Unrelated commits reuse the original report; changed/dirty inputs, tools, evidence or contracts invalidate it. Directories include additions/deletions. Reports without reviewed input scopes retain exact-candidate checks. Coupled validation groups still require every member ready; gate changes invalidate affected group measurements.

Before final review, workflow reconciles current main into clean project branches under integration locks. Conflicts stop for resolution; targets are untouched. Review binds candidate and target SHAs; movement requires preparation again. Only affected checks rerun, and integration rechecks the reviewed pair under lock.

Registered jobs defer token-review pauses and compaction until exit. CPU/log progress keeps maintenance deferred; ten awake minutes without progress triggers inspection, never automatic termination. Experiment budgets and update cadence still apply.

Checkpoint lateness gets one reminder per checkpoint, shared with experiment-budget notices. It does not by itself start recovery. Repeated failed attempts or sustained absence of progress/activity still trigger recovery. Worker updates return after saving; page builds run in the background and combine pending changes.

Unanswered token reviews are inspected after ten minutes and on inactivity alarms. Recent native reviewer activity defers retries. An idle reviewer gets one threaded retry of the same packet/threshold; an absent, provably idle bound session is resumed first. Unknown runtime state escalates without interruption. Ten minutes after retry, an unanswered inactive reviewer escalates to PM. Checks share a durable retry acknowledgement; no duplicate review cycle, hold release or replacement fork.

### Review compliance (mandatory)

Review guidance cannot override the AC experiment budget (maximum four minutes), including final builds. Generate the response with `work token-review-template`. Its `compliance` block pins current constraints and lists each action's instruction, expected_seconds, timeout_seconds and on_timeout checkpoint/scope-reduction fallback. Resume requires bounded actions; a pure hold may use an empty list. Do not prescribe work outside that list.

The review CLI checks compliance before changing gates, release conditions or resume state. An over-budget, unbounded, stale or incomplete response exits nonzero with specific corrections, saves a browsable rejection in Workflow Actions, and leaves the worker held. The submitting reviewer revises and resubmits the same review; no new review cycle or PM approval is required. Historical long-run findings belong in failed_turn_review, not executable direction. This submission guard checks declared plans; it does not itself enforce process runtime.

Coverage notifications remain pending handoffs until the required plan/reports exist. After ten minutes, inspect recipient activity and follow up once with an idle worker; ten minutes after an unanswered retry, escalate to PM. Native activity without publication for twenty minutes also escalates for diagnosis. Track conflicts defer dispatch but do not resolve the handoff. Reuse existing valid evidence; missing reports never authorize automatic acceptance or blind reruns.

### Downstream verification inputs

If delivered implementation needs a downstream artifact only for final checks, use a tracked request:
`work request PROJECT C4 WORKER --owner-ac C5 --purpose verification --artifact PATH --detail 'Package needed for final continuity measurement'`.
The CLI requires current delivered, unchanged hashed evidence and no failed requestor result. Delivery remains available to C5; coverage remains pending. Producer delivery and requester artifact verification trigger the pending checks without PM relay. Do not mark C4 blocked merely because C5's verification input is missing. A real implementation failure still invalidates delivery: use `work update ... blocked --implementation-failure` with the actual findings. Reverse peer dependencies are detected and routed for classification; automation never guesses that failed implementation is valid.

Delivered outcomes with current, hashed failing coverage automatically go to the permanent requestor for disposition; stale/missing reports and in-progress experiments do not count as delivered failures. Failures are grouped by AC. The existing review template includes `corrections.Cx`: `decision: resume|hold`, concrete `direction`, and the same bounded `compliance` actions used by token reviews. Submit through `work reject`; compliant resume corrections route to the temporary worker, hold dispositions preserve its pause. Evidence-based measurement corrections still use the gate workflow; goal changes require an explicit scope decision. Reviewer inactivity gets a follow-up and PM escalation. Do not repeatedly ask workers to make already-reported failures pass while disposition is pending.

## Baseline, fixture and capture preflight

Before edits, run the existing checks and record failures. Confirm the test can reach the state it is meant to measure. If it cannot, repair the test or record the blocker.

Scenario drivers must resolve assets from the worktree root, assert the loaded fixture, and capture only after the intended scenario phase completes. Wait for the frame to be written before advancing. Freeze clock/randomness/traffic where they affect comparison; first confirm repeated baseline captures are deterministic. Do not use process exit or a loading-screen frame as proof.

Per-AC token budget: **0.6M observed uncached input + output tokens**. At **0.4M**, nonblocking requestor review must correct course toward a finish within budget. At **0.6M**, requestor review must request wrap-up: salvage existing artifacts, verify/publish bounded results, name unmet criteria and stop implementation. An explicit budget extension records a cumulative ceiling without resetting usage; no automatic extension is allowed. At the ceiling, no new implementation experiments. Reviews must supply the template's `token_budget` finish plan; missing or conflicting responses are rejected to the reviewer. Safe checkpoints preserve running outputs; this is a mandatory review boundary, not a process kill or an automatic acceptance.

Automation retains the AC reservation through a pending token review and reuses its safe checkpoint for due compaction. A decided dependency/scope hold can release independent work. Coverage publication reminders start after verified producer delivery; workers may publish evidence earlier.

For unclaimed exact files in your sole-worker product, use `work ownership PROJECT AC --path relative/file --detail REASON`. Shared ownership, cross-product paths and conflicts require a recorded PM handoff. Existing locks and checks still apply.

Generate review responses with `work token-review-template`: the CLI pins the requirements, requires declared changes plus a formal disposition, checks the total remaining action estimate and token allowance, and rejects implementation actions at the 0.6M limit. Reviewers still assess whether the proposed actions actually preserve the requirements.
