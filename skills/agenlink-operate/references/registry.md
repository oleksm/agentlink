# Native YAML registry

Use an explicit workspace (`--home PATH` or `AGL_HOME`). Records live under
`registry/<Root>/metadata/` and schemas under `registry/<Root>/schema/`, with shared
schemas at `registry/`. Records keep their original fields and `identity.key`, such
as `component.example`. There is no `kind/id`, `data` or revision wrapper.

```sh
agentlink registry list
agentlink registry find pressure regulator
agentlink registry show component.example
agentlink registry schema-list
agentlink registry schema-show component
agentlink registry refs component.example
agentlink registry check
agentlink registry check --root DevProjects
```

Discovery reads YAML recursively, excluding schema files. Exact lookup uses the
record's identity key. Search requires every supplied word in the key or name.
`show` prints the YAML and its file/generated ownership. `view` exposes raw records,
file/schema metadata and ownership. The original browser renders records, schema
descriptions, links and project summaries directly.

## Schemas and drafts

The first line of each saved record names its schema relative to the record:

```yaml
# yaml-language-server: $schema=../../schema/component.schema.yaml
identity:
  key: component.example
  name: Example component
```

Schemas declare `x-kind` and their original JSON Schema fields in YAML. Local
`$ref` files and pointers resolve without network fetches. Inherited `allOf`
properties and required fields are flattened using the registry rules, preserving
closed-object validation. `x-ref` identifies allowed target record kinds. Schema
lint reports open objects, missing kind declarations, alternative discriminators
and unit annotations; unit checks use the registry's SI/degree convention.

```sh
agentlink registry new component example --folder Components/metadata/components
agentlink registry new intake example
agentlink registry validate component.example
agentlink registry validate --file draft.yaml
```

`new` uses the matching schema and its declared location, an existing record's
folder, or explicit `--folder`. It creates only required top-level fields as null;
required identity fields use TODO. Native project/intake/retrospective drafts
reserve permanent short IDs. Existing files are never replaced. A draft is not
execution authorization and does not enable a workflow.

Fill draft values before validation or submission. Use the [intake template](../../agenlink-manager/references/intake-template.md)
for an authorized project and `agentlink project submit --file draft.yaml --check`
before submission. Import existing original-schema objects with
`agentlink project import --file record.yaml` without launching workers.

## Native edits

```sh
agentlink registry set component.example description 'Revised description'
agentlink registry set component.example measurements.0.value '12.5'
agentlink registry set component.example related.+ 'component.other'
agentlink registry put --file component.yaml --path Components/metadata/components/example.yaml
agentlink registry own component.example --by tools/generate.mjs --keys computed,total
```

`set` parses a YAML value; dotted paths address object fields and list indexes,
and `+` appends. The first schema-comment line is preserved; other comments are
not retained by serialization. As in the keeper workflow, run `registry check`
after edits; editing a draft does not require pretending it already validates.
A project status edit uses append-only `update_status` semantics and requires an
explicit reason. Native short IDs remain permanent.

`put` accepts the original object and validates it against its named or selected
schema. For a new generic object, supply its registry-relative `--path`; `--schema`
can name a registry-relative schema file. Existing generated records cannot be
replaced. Generated ownership is recorded in `registry/generated.json` as tool and
optional owned keys; edits of overlapping fields are refused. Change generated
fields in their generator. Ownership is a coordination guard, not authentication.

Project transitions use `agentlink work`, `agentlink workers` and `agentlink workflow`,
preserving direct owner authorization, independent acceptance, evidence and holds.
Schema checks do not execute application-specific checks or prove measured outcomes.
