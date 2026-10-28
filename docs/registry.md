# Registry

The registry discovers original YAML objects under the selected workspace's
`registry/` tree. Records retain their own fields and dotted `identity.key`.
Their first line names a relative YAML schema; schemas declare `x-kind`, local
references, closed object shapes, units and record-reference kinds. No field-name
conversion, positional IDs or revisioned `data` wrapper is used by public commands
or the original registry browser.

Use [registry operations](../skills/agenlink-operate/references/registry.md) for
exact lookup, all-word search, schema-defined drafts, YAML field edits, schema and
reference checks, and generated-field ownership. `registry show` prints original
YAML; `registry new` writes required null/TODO placeholders without enabling a
project. Native project IDs are stable through archive.

Schemas belong to the installation’s registry tree and must be supplied before
project operations. Initialization installs missing workflow policy files;
customized workspace files remain intact. Generic checks reproduce the registry's schema subset and lint;
application-specific calculations and validators belong to the consumer package.
Independent project acceptance and evidence checks remain separate from schema
validation. Compilation alone does not establish executed functional parity.

## Publishing into an existing registry

An installation may opt into updating project sections of its existing domain
page. Create `registry-publication.json` in the workspace with `root` (an absolute
consumer repository path) and `page` (its registry HTML path relative to that
root), for example:

```json
{"root":"/srv/customer-project","page":"standards/index.html"}
```

Publication reads the latest page under the same `/tmp/pages-UID-ROOT_HASH.lock`
flock used by the domain builder. It replaces only DevProjects registers, their
navigation/schema metadata, and project/retrospective presentation data; domain
records and the existing page template remain intact. The domain builder must
likewise preserve platform sections under that lock. The old DevProjects page
redirects to the main registry while retaining the URL fragment. This is optional
installation configuration; package installation does not modify a consumer repo.

## Consumer compatibility

The packaged page retains the generic registry and project views. Root names and
registers come from discovered schemas and records, rather than a built-in domain
catalogue. Record fields, dotted keys, local schema references, project routes and
archive routes keep their existing formats; no record conversion is required.

A consumer can keep its specialized renderer in its own repository. Shared-page
publication updates the existing DATA payload while preserving that page's
renderer, domain registers and other domain payload fields. Package cleanup does
not replace consumer pages or install domain schemas or datasets. Schema example
text is descriptive only; removing a domain example does not alter validation.
