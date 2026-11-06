# Saved workflow marker and legacy update

The serializer writes `/* zody-workflow`. Saved-file and path readers recognize exactly the first nonempty line as either this marker or the legacy `/* zcode-workflow`; malformed recognized metadata fails rather than falling back to script. Inline SaveWorkflow rejects both markers. Raw snippet reads with frontmatter parsing disabled preserve every byte. Ordinary reads do not rewrite existing files, and the existing explicit global-to-project move preserves source bytes, including a legacy marker.

The existing saved-workflow owner resolves canonical project, legacy project, then global roots. An explicit metadata update of a legacy project definition creates a canonical project copy with the new serializer and leaves old bytes untouched. A canonical file that exists at resolution retains the established update behavior; an invalid canonical file blocks fallback. For this legacy-to-canonical update alone, complete content is written to a same-directory staging file whose name does not end in `.dwf.ts`, then published with an atomic no-replace link. An existing or concurrently created target is preserved and causes a visible failure; unsupported link is a failure, never an overwrite fallback. Before publication a failure attempts to remove the staging file and reports cleanup failure truthfully. After a successful link, cleanup failure cannot roll back or turn the published update into failure; it is logged best-effort and the non-workflow staging residue may remain. No other writer gains a concurrency guarantee from this rule.

```text
explicit update → resolve owner → serialize staged canonical → no-replace link → success
                              ↘ legacy bytes remain untouched          ↘ cleanup best effort
```
